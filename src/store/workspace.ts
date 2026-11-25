import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { useBoardUi } from "@/features/board/uiStore";
import { api, errorMessage, type BoardData, type ChangeSet, type Student, type WorkspaceInfo } from "@/lib/api";
import { reuseList, sameValue } from "./reuse";

interface WorkspaceState extends BoardData {
  workspace: WorkspaceInfo | null;
  studentsById: ReadonlyMap<number, Student>;
  historyError: string | null;
  setHistoryOpen: (open: boolean) => void;
  /**
   * 반편성 상태(되돌리기 대상)를 마지막으로 바꾼 변경의 표식. 변경·되돌리기·다시 실행에 성공하거나
   * 다른 파일로 바뀔 때마다 새 객체가 된다. "방금 그 변경만 되돌리기"에 쓴다.
   */
  lastChange: object;
  /** `token`이 아직 마지막 변경일 때만 되돌린다. 그사이 다른 변경이 있었으면 false */
  undoIfLatest: (token: object) => Promise<boolean>;
  /** XLSX를 막 가져와 로마자 성명 한글 표기 입력 단계를 띄워야 하는지 */
  pendingReadingPrompt: boolean;
  setPendingReadingPrompt: (v: boolean) => void;
  /** 작업 파일·보드 데이터를 다시 읽는다 */
  refresh: () => Promise<void>;
  setWorkspace: (w: WorkspaceInfo | null) => Promise<void>;
  /** 변경 묶음을 적용하고 다시 읽는다. 성공하면 true */
  applyChange: (cs: ChangeSet) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

async function updateTitle(w: WorkspaceInfo | null) {
  try {
    await getCurrentWindow().setTitle(w ? `${w.fileName}${w.readOnly ? " (읽기 전용)" : ""} — ClassMix` : "ClassMix");
  } catch {
    // 브라우저 미리보기 등 Tauri 밖에서는 무시
  }
}

const EMPTY_BOARD: BoardData & Pick<WorkspaceState, "studentsById" | "historyError"> = {
  students: [],
  studentsById: new Map(),
  gaps: [],
  classStates: [],
  rules: [],
  dismissedTwins: [],
  history: null,
  historyError: null,
  canUndo: false,
  canRedo: false,
};

export const useWorkspace = create<WorkspaceState>((set, get) => {
  let refreshVersion = 0;

  const refresh = async () => {
    const version = ++refreshVersion;
    const includeHistory = useBoardUi.getState().prefs.historyOpen;
    const snapshot = await api.getWorkspaceSnapshot(includeHistory).catch((error: unknown) => {
      if (version === refreshVersion && includeHistory && useBoardUi.getState().prefs.historyOpen) {
        set({ historyError: errorMessage(error) });
      }
      throw error;
    });
    if (version !== refreshVersion) return;
    const board = snapshot?.board;
    let workspace = snapshot?.workspace ?? null;
    set((prev) => {
      if (prev.workspace && workspace && sameValue(prev.workspace, workspace)) workspace = prev.workspace;
      if (!board) return { workspace, ...EMPTY_BOARD };
      // 다시 읽은 값 중 바뀌지 않은 객체·목록은 이전 참조를 그대로 써서, 바뀐 부분만 다시 그려지게 한다.
      const students = reuseList(prev.students, board.students, (s) => s.id);
      const history = useBoardUi.getState().prefs.historyOpen ? board.history : null;
      return {
        workspace,
        ...board,
        students,
        studentsById: students === prev.students ? prev.studentsById : new Map(students.map((s) => [s.id, s])),
        gaps: reuseList(prev.gaps, board.gaps, (g) => g.id),
        classStates: reuseList(prev.classStates, board.classStates, (c) => c.class),
        rules: reuseList(prev.rules, board.rules, (r) => r.id),
        dismissedTwins: reuseList(prev.dismissedTwins, board.dismissedTwins, ([a, b]) => `${a}-${b}`),
        history: history && prev.history ? reuseList(prev.history, history, (h) => h.id) : history,
        historyError: null,
      };
    });
    await updateTitle(workspace);
  };

  const mutate = async (operation: () => Promise<unknown>, failure: string) => {
    try {
      await operation();
      set({ lastChange: {} });
      return true;
    } catch (e) {
      toast.error(failure, { description: errorMessage(e) });
      return false;
    } finally {
      await refresh().catch(() => undefined);
    }
  };

  const replay = (operation: () => Promise<string | null>, action: string, failure: string) =>
    mutate(async () => {
      const label = await operation();
      if (label) toast(`${action}: ${label}`);
    }, failure);

  const undo = async () => {
    await replay(api.undoChange, "되돌리기", "되돌리지 못했습니다.");
  };

  return {
    workspace: null,
    ...EMPTY_BOARD,
    setHistoryOpen: (open) => {
      useBoardUi.getState().setPrefs({ historyOpen: open });
      if (open) void refresh().catch(() => undefined);
      else set({ history: null, historyError: null });
    },
    lastChange: {},
    pendingReadingPrompt: false,
    setPendingReadingPrompt: (v) => set({ pendingReadingPrompt: v }),
    refresh,
    setWorkspace: async (workspace) => {
      set({ lastChange: {} });
      if (workspace && !workspace.locked) {
        await refresh();
      } else {
        ++refreshVersion;
        set({ workspace, ...EMPTY_BOARD });
        await updateTitle(workspace);
      }
    },
    applyChange: (cs) => mutate(() => api.applyChange(cs), "변경하지 못했습니다."),
    undo,
    redo: async () => {
      await replay(api.redoChange, "다시 실행하기", "다시 실행하지 못했습니다.");
    },
    undoIfLatest: async (token) => {
      if (get().lastChange !== token) return false;
      await undo();
      return true;
    },
  };
});
