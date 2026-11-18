/**
 * PDF 행 ↔ XLSX 학생 매핑.
 *
 * 우선순위
 * 1. (진급반, 진급반번호) + 성명       → 자동 확정
 * 2. (이전반, 이전번호) + 성명          → 자동 확정. 이전 반·번호가 XLSX 안에서 유일할 때만
 * 3. 성명 단독                          → 확인 필요. 남은 학생·남은 PDF 행 양쪽에서 유일할 때만
 * 그 외는 미매칭(사용자가 직접 연결).
 *
 * 전입·전출 행은 매핑하지 않는다.
 */
import { nameKey } from "./normalize";
import type { PdfRow } from "./pdfTable";

export interface MatchStudent {
  id: number;
  studentNo: string;
  name: string;
  prevClass: number;
  prevNumber: number;
  origClass: number;
  origNumber: number;
}

export type MatchMethod = "next_seat+name" | "prev_seat+name" | "name" | "manual";

export interface Match {
  rowIndex: number;
  studentId: number;
  method: MatchMethod;
  /** auto: 자동 확정, review: 확인 필요 */
  confidence: "auto" | "review";
}

export interface MatchResult {
  matches: Match[];
  /** 매핑 대상(전입·전출 아님)인데 연결되지 않은 PDF 행 */
  unmatchedRows: number[];
  /** PDF에서 짝을 찾지 못한 학생 */
  unmatchedStudents: number[];
  /** 전입·전출이라 건너뛴 PDF 행 */
  skippedRows: number[];
}

const seat = (c: number | null, n: number | null) => `${c}-${n}`;

export function matchPdfRows(rows: PdfRow[], students: MatchStudent[]): MatchResult {
  const matches: Match[] = [];
  const usedStudents = new Set<number>();
  const usedRows = new Set<number>();
  const skippedRows: number[] = [];
  const candidates: number[] = [];
  rows.forEach((r, i) => (r.status === "regular" ? candidates.push(i) : skippedRows.push(i)));

  const link = (rowIndex: number, studentId: number, method: MatchMethod, confidence: Match["confidence"]) => {
    matches.push({ rowIndex, studentId, method, confidence });
    usedRows.add(rowIndex);
    usedStudents.add(studentId);
  };

  // 1. 진급반·번호 + 성명
  const byNextSeat = new Map<string, MatchStudent>();
  for (const s of students) byNextSeat.set(seat(s.origClass, s.origNumber), s);
  for (const i of candidates) {
    const r = rows[i];
    const s = byNextSeat.get(seat(r.class, r.number));
    if (s && !usedStudents.has(s.id) && nameKey(s.name) === nameKey(r.name)) link(i, s.id, "next_seat+name", "auto");
  }

  // 2. 이전반·번호 + 성명 (유일한 키만)
  const byPrevSeat = new Map<string, MatchStudent[]>();
  for (const s of students) {
    const k = seat(s.prevClass, s.prevNumber);
    byPrevSeat.set(k, [...(byPrevSeat.get(k) ?? []), s]);
  }
  for (const i of candidates) {
    if (usedRows.has(i)) continue;
    const r = rows[i];
    if (r.prevClass == null || r.prevNumber == null) continue;
    const list = byPrevSeat.get(seat(r.prevClass, r.prevNumber));
    if (list?.length !== 1) continue;
    const s = list[0];
    if (!usedStudents.has(s.id) && nameKey(s.name) === nameKey(r.name)) link(i, s.id, "prev_seat+name", "auto");
  }

  // 3. 성명 단독 (양쪽 모두 유일할 때)
  const restStudents = students.filter((s) => !usedStudents.has(s.id));
  const restRows = candidates.filter((i) => !usedRows.has(i));
  const countBy = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return m;
  };
  const studentsByName = countBy(restStudents, (s) => nameKey(s.name));
  const rowsByName = countBy(restRows, (i) => nameKey(rows[i].name));
  for (const [key, rowList] of rowsByName) {
    const sList = studentsByName.get(key);
    if (rowList.length === 1 && sList?.length === 1) link(rowList[0], sList[0].id, "name", "review");
  }

  matches.sort((a, b) => a.rowIndex - b.rowIndex);
  return {
    matches,
    unmatchedRows: candidates.filter((i) => !usedRows.has(i)),
    unmatchedStudents: students.filter((s) => !usedStudents.has(s.id)).map((s) => s.id),
    skippedRows,
  };
}
