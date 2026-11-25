import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { api, errorMessage, type BoardData, type ChangeSet, type Student, type WorkspaceInfo } from "@/lib/api";
import { reuseList, sameValue } from "./reuse";

interface WorkspaceState extends BoardData {
  workspace: WorkspaceInfo | null;
  studentsById: ReadonlyMap<number, Student>;
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

const EMPTY_BOARD: BoardData & Pick<WorkspaceState, "studentsById"> = {
  students: [],
  studentsById: new Map(),
  gaps: [],
  classStates: [],
  rules: [],
  dismissedTwins: [],
  history: [],
  canUndo: false,
  canRedo: false,
};

export const useWorkspace = create<WorkspaceState>((set) => {
  let refreshVersion = 0;

  const refresh = async () => {
    const version = ++refreshVersion;
    const snapshot = await api.getWorkspaceSnapshot();
    if (version !== refreshVersion) return;
    const board = snapshot?.board;
    let workspace = snapshot?.workspace ?? null;
    set((prev) => {
      if (prev.workspace && workspace && sameValue(prev.workspace, workspace)) workspace = prev.workspace;
      if (!board) return { workspace, ...EMPTY_BOARD };
      // 다시 읽은 값 중 바뀌지 않은 객체·목록은 이전 참조를 그대로 써서, 바뀐 부분만 다시 그려지게 한다.
      const students = reuseList(prev.students, board.students, (s) => s.id);
      return {
        workspace,
        ...board,
        students,
        studentsById: students === prev.students ? prev.studentsById : new Map(students.map((s) => [s.id, s])),
        gaps: reuseList(prev.gaps, board.gaps, (g) => g.id),
        classStates: reuseList(prev.classStates, board.classStates, (c) => c.class),
        rules: reuseList(prev.rules, board.rules, (r) => r.id),
        dismissedTwins: reuseList(prev.dismissedTwins, board.dismissedTwins, ([a, b]) => `${a}-${b}`),
        history: reuseList(prev.history, board.history, (h) => h.id),
      };
    });
    await updateTitle(workspace);
  };

  const mutate = async (operation: () => Promise<unknown>, failure: string) => {
    try {
      await operation();
      return true;
    } catch (e) {
      toast.error(failure, { description: errorMessage(e) });
      return false;
    } finally {
      await refresh().catch(() => undefined);
    }
  };

  const replay = async (operation: () => Promise<string | null>, action: string, failure: string) => {
    await mutate(async () => {
      const label = await operation();
      if (label) toast(`${action}: ${label}`);
    }, failure);
  };

  return {
    workspace: null,
    ...EMPTY_BOARD,
    pendingReadingPrompt: false,
    setPendingReadingPrompt: (v) => set({ pendingReadingPrompt: v }),
    refresh,
    setWorkspace: async (workspace) => {
      if (workspace && !workspace.locked) {
        await refresh();
      } else {
        ++refreshVersion;
        set({ workspace, ...EMPTY_BOARD });
        await updateTitle(workspace);
      }
    },
    applyChange: (cs) => mutate(() => api.applyChange(cs), "변경하지 못했습니다."),
    undo: () => replay(api.undoChange, "되돌리기", "되돌리지 못했습니다."),
    redo: () => replay(api.redoChange, "다시 실행하기", "다시 실행하지 못했습니다."),
  };
});
