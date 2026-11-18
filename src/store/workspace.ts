import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import {
  api,
  errorMessage,
  type ChangeSet,
  type ClassState,
  type Gap,
  type HistoryEntry,
  type Rule,
  type Student,
  type WorkspaceInfo,
} from "@/lib/api";

interface WorkspaceState {
  workspace: WorkspaceInfo | null;
  students: Student[];
  gaps: Gap[];
  classStates: ClassState[];
  rules: Rule[];
  dismissedTwins: [number, number][];
  history: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  /** XLSX를 막 가져와 로마자 이름 한글 발음 입력 단계를 띄워야 하는지 */
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

const EMPTY_BOARD = {
  students: [],
  gaps: [],
  classStates: [],
  rules: [],
  dismissedTwins: [],
  history: [],
  canUndo: false,
  canRedo: false,
};

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspace: null,
  ...EMPTY_BOARD,
  pendingReadingPrompt: false,
  setPendingReadingPrompt: (v) => set({ pendingReadingPrompt: v }),
  refresh: async () => {
    const workspace = await api.getWorkspace();
    if (!workspace) {
      set({ workspace: null, ...EMPTY_BOARD });
      await updateTitle(null);
      return;
    }
    const board = await api.getBoard();
    set({ workspace, ...board });
    await updateTitle(workspace);
  },
  setWorkspace: async (w) => {
    set({ workspace: w });
    await updateTitle(w);
    if (w) await get().refresh();
    else set(EMPTY_BOARD);
  },
  applyChange: async (cs) => {
    try {
      await api.applyChange(cs);
      return true;
    } catch (e) {
      toast.error("변경하지 못했습니다.", { description: errorMessage(e) });
      return false;
    } finally {
      await get()
        .refresh()
        .catch(() => undefined);
    }
  },
  undo: async () => {
    try {
      const label = await api.undoChange();
      if (label) toast(`되돌림: ${label}`);
    } catch (e) {
      toast.error("되돌리지 못했습니다.", { description: errorMessage(e) });
    } finally {
      await get()
        .refresh()
        .catch(() => undefined);
    }
  },
  redo: async () => {
    try {
      const label = await api.redoChange();
      if (label) toast(`다시 실행: ${label}`);
    } catch (e) {
      toast.error("다시 실행하지 못했습니다.", { description: errorMessage(e) });
    } finally {
      await get()
        .refresh()
        .catch(() => undefined);
    }
  },
}));
