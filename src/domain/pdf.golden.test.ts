/**
 * 골든 테스트: tests/fixtures/sample.pdf 를 실제 pdf.js(Node용 legacy 빌드)로 읽어
 * 표 복원과 XLSX 매핑 결과를 확인한다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfPages } from "./pdfExtract";
import { matchPdfRows, type MatchStudent } from "./matching";
import { parsePdfPages, type PdfParseResult } from "./pdfTable";

const fixtures = path.resolve(import.meta.dirname, "../../tests/fixtures");

let parsed: PdfParseResult;
let students: MatchStudent[];

beforeAll(async () => {
  const data = new Uint8Array(await readFile(path.join(fixtures, "sample.pdf")));
  parsed = parsePdfPages(await extractPdfPages(pdfjs as never, data));
  students = JSON.parse(await readFile(path.join(fixtures, "sample-students.json"), "utf8"));
});

describe("sample.pdf", () => {
  it("reads every row and agrees with each page footer", () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(235);
    expect(parsed.pages).toHaveLength(8);
    expect(parsed.pages.every((p) => p.ok)).toBe(true);
    // 샘플 6쪽 요약은 남 13 + 여 15 ≠ 계 29 로 원본 자체가 맞지 않는다 → 안내만
    const notes = parsed.pages.filter((p) => p.message).map((p) => p.page);
    expect(notes).toEqual([6]);
  });

  it("joins wrapped names", () => {
    const names = parsed.rows.map((r) => r.name);
    expect(names).toContain("Ayu Lestari Tom");
    expect(names).toContain("Hannah Cruz Qu");
  });

  it("parses a regular row", () => {
    const r = parsed.rows.find((x) => x.class === 1 && x.number === 2)!;
    expect(r).toMatchObject({
      grade: "2학년",
      name: "꼬부기",
      birthDate: "2010-10-11",
      gender: "남",
      baseScore: 729.22,
      status: "regular",
      prevGrade: "1학년",
      prevClass: 4,
      prevNumber: 15,
    });
  });

  it("marks transfer rows", () => {
    const t = parsed.rows.filter((r) => r.status !== "regular").map((r) => [r.name, r.status]);
    expect(t).toEqual([
      ["토실이", "transfer_out"],
      ["하늘이", "transfer_in"],
      ["라온", "transfer_out"],
      ["옥수수", "transfer_in"],
    ]);
  });

  it("maps all 231 students to the XLSX by next seat and name", () => {
    const res = matchPdfRows(parsed.rows, students);
    expect(res.skippedRows).toHaveLength(4);
    expect(res.matches).toHaveLength(231);
    expect(res.matches.every((m) => m.method === "next_seat+name")).toBe(true);
    expect(res.unmatchedRows).toEqual([]);
    expect(res.unmatchedStudents).toEqual([]);
  });

  it("does not mis-link students sharing a previous seat when next seats are unknown", () => {
    // 진급반 정보를 지운 상태(다른 시점의 PDF)를 흉내 낸다.
    const shifted = students.map((s) => ({ ...s, origClass: 99, origNumber: s.id }));
    const res = matchPdfRows(parsed.rows, shifted);
    const byId = new Map(shifted.map((s) => [s.id, s]));
    for (const m of res.matches) {
      expect(byId.get(m.studentId)!.name.trim()).toBe(parsed.rows[m.rowIndex].name);
    }
    // 이전 4-6, 6-28 이 겹치는 4명은 이름으로만 이어지므로 '확인 필요'
    const review = res.matches.filter((m) => m.confidence === "review").map((m) => byId.get(m.studentId)!.name);
    expect(review.sort()).toEqual(["달다구리", "멍멍이", "소복이", "팽이돌이"]);
    expect(res.matches).toHaveLength(231);
  });
});
