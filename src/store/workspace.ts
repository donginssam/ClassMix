import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type Gap, type Student, type WorkspaceInfo } from "@/lib/api";

interface WorkspaceState {
  workspace: WorkspaceInfo | null;
  students: Student[];
  gaps: Gap[];
  /** 작업 파일·학생 목록을 다시 읽는다 */
  refresh: () => Promise<void>;
  setWorkspace: (w: WorkspaceInfo | null) => Promise<void>;
}

async function updateTitle(w: WorkspaceInfo | null) {
  try {
    await getCurrentWindow().setTitle(w ? `${w.fileName}${w.readOnly ? " (읽기 전용)" : ""} — ClassMix` : "ClassMix");
  } catch {
    // 브라우저 미리보기 등 Tauri 밖에서는 무시
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspace: null,
  students: [],
  gaps: [],
  refresh: async () => {
    const workspace = await api.getWorkspace();
    if (!workspace) {
      set({ workspace: null, students: [], gaps: [] });
      await updateTitle(null);
      return;
    }
    const [students, gaps] = await Promise.all([api.listStudents(), api.listGaps()]);
    set({ workspace, students, gaps });
    await updateTitle(workspace);
  },
  setWorkspace: async (w) => {
    set({ workspace: w });
    await updateTitle(w);
    if (w) await get().refresh();
    else set({ students: [], gaps: [] });
  },
}));
