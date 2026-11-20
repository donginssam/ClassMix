/** 보드 화면 상태(선택·대화상자·하이라이트·표시 옵션). 학생 데이터는 이 스토어에 저장하지 않는다. */
import { create } from "zustand";

export type BoardDialog =
  | { kind: "number"; studentId: number }
  | { kind: "gapName"; gapId: number }
  | { kind: "memo"; studentId: number }
  | { kind: "reading"; studentIds: number[] | "all" }
  | { kind: "separation"; tab?: string; preselect?: number[]; preselectTab?: string }
  | { kind: "twins" }
  | { kind: "export" }
  | { kind: "reset" }
  | { kind: "pdf" }
  | { kind: "settings" }
  | { kind: "shortcuts" };

export interface ViewPrefs {
  showGender: boolean;
  showBirth: boolean;
  showScore: boolean;
  showPrev: boolean;
  showMemo: boolean;
  statsOpen: boolean;
  historyOpen: boolean;
}

const PREFS_KEY = "classmix.viewPrefs";
const DEFAULT_PREFS: ViewPrefs = {
  showGender: true,
  showBirth: false,
  showScore: true,
  showPrev: true,
  showMemo: true,
  statsOpen: false,
  historyOpen: false,
};

function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ViewPrefs>) };
  } catch {
    // 저장소를 못 쓰면 기본값
  }
  return DEFAULT_PREFS;
}

interface BoardUi {
  /** 선택한 학생(최대 2명) */
  selected: number[];
  toggleSelect: (id: number) => void;
  clearSelection: () => void;
  dialog: BoardDialog | null;
  openDialog: (d: BoardDialog) => void;
  closeDialog: () => void;
  /** 검색·이력에서 강조할 학생 */
  highlight: Set<number>;
  setHighlight: (ids: Iterable<number>) => void;
  /** 드래그 중 위반이 새로 생길 반 */
  previewViolation: Set<number>;
  setPreviewViolation: (s: Set<number>) => void;
  prefs: ViewPrefs;
  setPrefs: (p: Partial<ViewPrefs>) => void;
}

export const useBoardUi = create<BoardUi>((set, get) => ({
  selected: [],
  toggleSelect: (id) => {
    const cur = get().selected;
    if (cur.includes(id)) set({ selected: cur.filter((x) => x !== id) });
    else set({ selected: [...cur, id].slice(-2) });
  },
  clearSelection: () => set({ selected: [] }),
  dialog: null,
  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
  highlight: new Set(),
  setHighlight: (ids) => set({ highlight: new Set(ids) }),
  previewViolation: new Set(),
  setPreviewViolation: (s) => set({ previewViolation: s }),
  prefs: loadPrefs(),
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // 무시
    }
  },
}));

/** 학생 카드로 스크롤하고 잠깐 강조한다. */
export function scrollToStudent(id: number) {
  const el = document.querySelector(`[data-student-id="${id}"]`);
  el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
}
