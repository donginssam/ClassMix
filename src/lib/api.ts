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
  createdAt: string;
  updatedAt: string;
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

export interface SkippedRow {
  row: number;
  studentNo: string;
  name: string;
  reason: string;
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
  skipped: SkippedRow[];
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
  plannedName: string | null;
  origin: "manual" | "import";
}

export interface PdfRowInput {
  page: number;
  grade: string;
  class: number;
  number: number;
  name: string;
  birthDate: string | null;
  gender: "남" | "여" | null;
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

/** Rust `AppError` 직렬화 형태 */
export interface AppErrorPayload {
  code: string;
  message: string;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as AppErrorPayload).message);
  return String(e);
}

export const api = {
  createWorkFile: (path: string) => invoke<WorkspaceInfo>("create_work_file", { path }),
  openWorkFile: (path: string) => invoke<OpenResult>("open_work_file", { path }),
  closeWorkFile: () => invoke<void>("close_work_file"),
  getWorkspace: () => invoke<WorkspaceInfo | null>("get_workspace"),
  saveWorkFileAs: (path: string) => invoke<WorkspaceInfo>("save_work_file_as", { path }),
  saveWorkFileCopy: (path: string) => invoke<string>("save_work_file_copy", { path }),
  listRecentFiles: () => invoke<RecentFile[]>("list_recent_files"),
  removeRecentFile: (path: string) => invoke<void>("remove_recent_file", { path }),
  importXlsx: (path: string) => invoke<{ report: ImportReport; workspace: WorkspaceInfo }>("import_xlsx", { path }),
  listStudents: () => invoke<Student[]>("list_students"),
  listGaps: () => invoke<Gap[]>("list_gaps"),
  readPdfFile: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_pdf_file", { path })),
  applyPdfMapping: (path: string, rows: PdfRowInput[], links: PdfLink[]) =>
    invoke<PdfApplyReport>("apply_pdf_mapping", { path, rows, links }),
  /** 개발용(디버그 빌드에서만 값이 있음) */
  devSamplePaths: () => invoke<{ xlsx: string; pdf: string } | null>("dev_sample_paths"),
};
