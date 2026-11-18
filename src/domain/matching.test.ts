import { describe, expect, it } from "vitest";
import { matchPdfRows, type MatchStudent } from "./matching";
import type { PdfRow } from "./pdfTable";

const row = (p: Partial<PdfRow>): PdfRow => ({
  page: 1,
  grade: "2학년",
  class: 1,
  number: 1,
  name: "가",
  birthRaw: "",
  birthDate: null,
  gender: "남",
  baseScore: 500,
  status: "regular",
  prevGrade: "1학년",
  prevClass: 1,
  prevNumber: 1,
  note: null,
  ...p,
});

const student = (p: Partial<MatchStudent>): MatchStudent => ({
  id: 1,
  studentNo: "1",
  name: "가",
  prevClass: 1,
  prevNumber: 1,
  origClass: 1,
  origNumber: 1,
  ...p,
});

describe("matchPdfRows", () => {
  it("requires the name to agree with the seat", () => {
    const res = matchPdfRows([row({ name: "나" })], [student({ name: "가" })]);
    expect(res.matches).toEqual([]);
    expect(res.unmatchedRows).toEqual([0]);
  });

  it("never uses a duplicated previous seat", () => {
    const rows = [row({ class: 9, number: 9, name: "가", prevClass: 4, prevNumber: 6 })];
    const students = [
      student({ id: 1, name: "가", prevClass: 4, prevNumber: 6, origClass: 1, origNumber: 1 }),
      student({ id: 2, name: "나", prevClass: 4, prevNumber: 6, origClass: 1, origNumber: 2 }),
    ];
    const res = matchPdfRows(rows, students);
    expect(res.matches).toEqual([{ rowIndex: 0, studentId: 1, method: "name", confidence: "review" }]);
  });

  it("leaves same-name students for manual linking", () => {
    const rows = [row({ class: 9, number: 1, name: "바쿠", prevClass: null, prevNumber: null })];
    const students = [
      student({ id: 1, name: "바쿠", origClass: 1, origNumber: 1 }),
      student({ id: 2, name: "바쿠", origClass: 2, origNumber: 2 }),
    ];
    const res = matchPdfRows(rows, students);
    expect(res.matches).toEqual([]);
    expect(res.unmatchedStudents).toEqual([1, 2]);
  });

  it("skips transfer rows", () => {
    const res = matchPdfRows([row({ status: "transfer_in" })], [student({})]);
    expect(res.skippedRows).toEqual([0]);
    expect(res.matches).toEqual([]);
  });
});
