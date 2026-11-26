/** Rust 커맨드 호출 래퍼와 타입(Rust DTO와 같은 모양). */
import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceInfo {
  path: string;
  fileName: string;
  title: string;
  readOnly: boolean;
  targetGrade: string | null;
  classCount: number | null;
  studentCount: number;
  xlsxFileName: string | null;
  pdfFileName: string | null;
  pdfLinkedCount: number;
  /** 암호가 걸린 파일인지 */
  encrypted: boolean;
  /** 암호가 걸려 있고 아직 비밀번호를 넣지 않았는지(학생 자료를 읽을 수 없음) */
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  /** 이 파일을 연 세션. 파일을 열 때마다 바뀐다(미리보기를 만든 파일인지 확인용). */
  sessionId: number;
}

export interface OpenResult {
  workspace: WorkspaceInfo;
  warnings: string[];
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
  exists: boolean;
}

export interface ClassSummary {
  class: number;
  count: number;
  gaps: number[];
}

export interface ImportReport {
  fileName: string;
  totalRows: number;
  imported: number;
  warnings: string[];
  targetGrade: string;
  classCount: number;
  classes: ClassSummary[];
  sameNameGroups: string[][];
  romanNameCount: number;
}

export interface Student {
  id: number;
  studentNo: string;
  name: string;
  nameNorm: string;
  prevGrade: string;
  prevClass: number;
  prevNumber: number;
  origClass: number;
  origNumber: number;
  curClass: number;
  curNumber: number;
  gender: "남" | "여" | null;
  birthDate: string | null;
  /** 기준성적 ×100 정수(0.01점 단위). 화면에서는 formatScore로 1/100으로 환산하여 표시 */
  baseScore: number | null;
  matchMethod: string | null;
  memo: string | null;
  sortName: string | null;
  sameName: boolean;
}

export interface Gap {
  id: number;
  class: number;
  number: number;
  anchorKey: string;
  plannedName: string | null;
  origin: "manual" | "import";
  createdAt: string;
}

export type Numbering = "original" | "sorted";

export interface ClassState {
  class: number;
  numbering: Numbering;
}

export type RuleKind = "group" | "one_to_many" | "twin" | "same_name";

export interface RuleMember {
  studentId: number;
  role: "member" | "leader";
}

export interface Rule {
  id: number;
  kind: RuleKind;
  origin: "manual" | "auto";
  enabled: boolean;
  reason: string | null;
  createdAt: string;
  members: RuleMember[];
}

export interface HistoryEntry {
  id: number;
  seq: number;
  action: string;
  label: string;
  studentIds: number[];
  undone: boolean;
  createdAt: string;
}

export interface BoardData {
  students: Student[];
  gaps: Gap[];
  classStates: ClassState[];
  rules: Rule[];
  dismissedTwins: [number, number][];
  history: HistoryEntry[] | null;
  canUndo: boolean;
  canRedo: boolean;
}

export type StudentPlacement = [id: number, curClass: number, curNumber: number, sortName: string | null];

export interface WorkspaceSnapshot {
  workspace: WorkspaceInfo;
  board:
    | (Omit<BoardData, "students"> &
        ({ students: Student[]; studentPlacements: null } | { students: null; studentPlacements: StudentPlacement[] }))
    | null;
  rosterVersion: string | null;
}

export interface Seat {
  c: number;
  n: number;
}

/** 빈 번호 한 줄(변경 묶음 안). */
export interface GapRow {
  number: number;
  anchorKey: string;
  plannedName: string | null;
  origin: "manual" | "import";
  createdAt?: string | null;
}

export type ChangeAction =
  "swap" | "move" | "renumber" | "set_number" | "gap_add" | "gap_remove" | "gap_edit" | "set_reading" | "reset";

/** Rust `changes::ChangeSet`과 같은 모양. 바꾸기 전·후 값을 모두 담는다. */
export interface ChangeSet {
  action: ChangeAction;
  label: string;
  students: { studentId: number; from: Seat; to: Seat }[];
  gaps: { class: number; before: GapRow[]; after: GapRow[] }[];
  numbering: { class: number; from: Numbering; to: Numbering }[];
  readings: { studentId: number; from: string | null; to: string | null }[];
}

export interface ExportReport {
  path: string;
  rows: number;
  changedStudents: number;
}

export interface PdfRowInput {
  page: number;
  grade: string;
  class: number;
  number: number;
  name: string;
  birthDate: string | null;
  gender: "남" | "여" | null;
  /** 기준성적 ×100 정수(0.01점 단위) */
  baseScore: number | null;
  prevGrade: string | null;
  prevClass: number | null;
  prevNumber: number | null;
  note: string | null;
}

export interface PdfLink {
  rowIndex: number;
  studentId: number;
  method: "next_seat+name" | "prev_seat+name" | "name" | "manual";
}

export interface PdfApplyReport {
  linked: number;
  unlinkedRows: number;
}

/** `.mix` 파일 연결 상태(Windows). macOS는 번들이 자동 등록하므로 `unsupported`. */
export interface AssociationStatus {
  state: "unsupported" | "none" | "current" | "moved";
  registeredExe: string | null;
  currentExe: string | null;
}

/** Rust `AppError` 직렬화 형태 */
export interface AppErrorPayload {
  code: string;
  message: string;
}

export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as AppErrorPayload).code);
  return undefined;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as AppErrorPayload).message);
  return String(e);
}

export const api = {
  createWorkFile: (path: string) => invoke<WorkspaceInfo>("create_work_file", { path }),
  openWorkFile: (path: string) => invoke<OpenResult>("open_work_file", { path }),
  closeWorkFile: () => invoke<void>("close_work_file"),
  getWorkspaceSnapshot: (includeHistory: boolean, knownRosterVersion: string | null) =>
    invoke<WorkspaceSnapshot | null>("get_workspace_snapshot", { includeHistory, knownRosterVersion }),
  saveWorkFileAs: (path: string) => invoke<WorkspaceInfo>("save_work_file_as", { path }),
  saveWorkFileCopy: (path: string) => invoke<string>("save_work_file_copy", { path }),
  listRecentFiles: () => invoke<RecentFile[]>("list_recent_files"),
  removeRecentFile: (path: string) => invoke<void>("remove_recent_file", { path }),
  importXlsx: (path: string) => invoke<{ report: ImportReport; workspace: WorkspaceInfo }>("import_xlsx", { path }),
  readPdfFile: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_pdf_file", { path })),
  applyPdfMapping: (sessionId: number, path: string, rows: PdfRowInput[], links: PdfLink[]) =>
    invoke<PdfApplyReport>("apply_pdf_mapping", { sessionId, path, rows, links }),
  applyChange: (change: ChangeSet) => invoke<void>("apply_change", { change }),
  undoChange: () => invoke<string | null>("undo_change"),
  redoChange: () => invoke<string | null>("redo_change"),
  setMemo: (studentId: number, memo: string | null) => invoke<void>("set_memo", { studentId, memo }),
  createRule: (rule: { kind: RuleKind; reason: string | null; members: RuleMember[] }) =>
    invoke<number>("create_rule", { rule }),
  updateRule: (id: number, enabled: boolean, reason: string | null) =>
    invoke<void>("update_rule", { id, enabled, reason }),
  deleteRule: (id: number) => invoke<void>("delete_rule", { id }),
  resolveTwinCandidates: (register: number[][], dismiss: number[][]) =>
    invoke<void>("resolve_twin_candidates", { register, dismiss }),
  exportXlsx: (path: string) => invoke<ExportReport>("export_xlsx", { path }),
  unlockWorkFile: (password: string) => invoke<WorkspaceInfo>("unlock_work_file", { password }),
  enableEncryption: (password: string) => invoke<WorkspaceInfo>("enable_encryption", { password }),
  disableEncryption: (password: string) => invoke<WorkspaceInfo>("disable_encryption", { password }),
  changePassword: (current: string, newPassword: string) =>
    invoke<WorkspaceInfo>("change_password", { current, newPassword }),
  /** 더블클릭·두 번째 실행으로 받은 .mix 경로(한 번만 돌려줌) */
  takeLaunchFile: () => invoke<string | null>("take_launch_file"),
  fileAssociationStatus: () => invoke<AssociationStatus>("file_association_status"),
  registerFileAssociation: () => invoke<AssociationStatus>("register_file_association"),
  unregisterFileAssociation: () => invoke<AssociationStatus>("unregister_file_association"),
  /** 개발용(디버그 빌드에서만 값이 있음) */
  devSamplePaths: () => invoke<{ xlsx: string; pdf: string } | null>("dev_sample_paths"),
};
