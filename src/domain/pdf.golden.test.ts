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
import { twinCandidates } from "./siblings";
import { overallStats } from "./stats";
import { student } from "./testBoard";
import { formatScore } from "@/lib/format";

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
    expect(parsed.rows).toHaveLength(240);
    expect(parsed.pages).toHaveLength(8);
    expect(parsed.pages.every((p) => p.ok && p.message == null)).toBe(true);
    // 나이스 표준 인원 요약 `남(18)명 여(12)명 계:(30)`
    expect(parsed.pages[0].footer).toEqual({ male: 18, female: 12, total: 30 });
  });

  it("joins Korean names wrapped mid-word without a space", () => {
    const names = parsed.rows.map((r) => r.name);
    expect(names).toContain("귀여운제비꽃");
    expect(names).toContain("용감한오랑우탄");
    expect(names.filter((n) => /[가-힣] [가-힣]/.test(n))).toEqual([]);
    expect(names).toContain("GRACE BRIAR");
  });

  it("parses a regular row, including a score with a thousands separator", () => {
    const r = parsed.rows.find((x) => x.class === 1 && x.number === 9)!;
    expect(r).toMatchObject({
      grade: "2학년",
      name: "단풍나무",
      birthDate: "2012-09-24",
      gender: "남",
      scoreRaw: "1,073.89",
      baseScore: 107389,
      prevGrade: "1학년",
      prevClass: 3,
      prevNumber: 8,
    });
    expect(parsed.rows.every((x) => x.baseScore != null && x.birthDate != null && x.gender != null)).toBe(true);
  });

  it("maps all 240 students to the XLSX by next seat and name", () => {
    const res = matchPdfRows(parsed.rows, students);
    expect(res.matches).toHaveLength(240);
    expect(res.matches.every((m) => m.method === "next_seat+name")).toBe(true);
    expect(res.unmatchedRows).toEqual([]);
    expect(res.unmatchedStudents).toEqual([]);
  });

  it("links correctly by previous seat and name when next seats are unknown", () => {
    // 진급반 정보를 지운 상태(다른 시점의 PDF)를 흉내 낸다.
    const shifted = students.map((s) => ({ ...s, origClass: 99, origNumber: s.id }));
    const res = matchPdfRows(parsed.rows, shifted);
    const byId = new Map(shifted.map((s) => [s.id, s]));
    for (const m of res.matches) {
      expect(byId.get(m.studentId)!.name.trim()).toBe(parsed.rows[m.rowIndex].name);
    }
    expect(res.matches).toHaveLength(240);
    expect(res.matches.every((m) => m.confidence === "auto")).toBe(true);
  });

  it("groups twin candidates by birth date", () => {
    const res = matchPdfRows(parsed.rows, students);
    const list = res.matches.map((m) => ({
      id: m.studentId,
      nameNorm: parsed.rows[m.rowIndex].name,
      birthDate: parsed.rows[m.rowIndex].birthDate,
    }));
    const c = twinCandidates(list, [], []);
    // 240명이 모두 같은 해에 태어나 생일이 겹치는 묶음이 많다. "가능"은 기본으로 등록하지 않는다.
    expect(c.filter((x) => x.grade === "likely")).toHaveLength(7);
    expect(c.filter((x) => x.grade === "possible")).toHaveLength(59);
    expect(c.filter((x) => x.studentIds.length === 3)).toHaveLength(10);
  });
});

/**
 * 기준성적을 100배 정수로 다루는지 샘플 전체로 확인한다.
 * 기대값은 구현과 별개로 PDF 원문 글자에서 BigInt로 직접 계산한다(부동소수점 없음).
 */
describe("sample.pdf scores as integer hundredths", () => {
  /** `1,073.89` → 107389n (구현과 독립된 계산) */
  const rawToX100 = (raw: string) => {
    const [i, f = ""] = raw.replace(/,/g, "").split(".");
    return BigInt(i + f.padEnd(2, "0"));
  };
  /** 100배 BigInt → `1,073.89` (구현과 독립된 표기) */
  const showX100 = (v: bigint) => {
    const i = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${i}.${(v % 100n).toString().padStart(2, "0")}`;
  };
  /** 반올림(0.5 올림) 평균 */
  const meanOf = (xs: bigint[]) => {
    const n = BigInt(xs.length);
    const sum = xs.reduce((a, b) => a + b, 0n);
    return (2n * sum + n) / (2n * n);
  };

  it("stores every score as an integer equal to the PDF digits", () => {
    expect(parsed.rows).toHaveLength(240);
    for (const r of parsed.rows) {
      expect(Number.isSafeInteger(r.baseScore), r.scoreRaw).toBe(true);
      expect(BigInt(r.baseScore!), r.scoreRaw).toBe(rawToX100(r.scoreRaw));
    }
  });

  it("displays every score exactly as printed in the PDF", () => {
    const mismatches = parsed.rows.filter((r) => formatScore(r.baseScore) !== r.scoreRaw);
    expect(mismatches.map((r) => [r.scoreRaw, formatScore(r.baseScore)])).toEqual([]);
    // 1,000점 이상(쉼표)·끝자리 0(예: 382.30)도 그대로
    expect(parsed.rows.filter((r) => r.scoreRaw.includes(",")).length).toBe(33);
    expect(parsed.rows.some((r) => r.scoreRaw.endsWith("0"))).toBe(true);
  });

  it("computes class and grade averages identical to an independent BigInt calculation", () => {
    const res = matchPdfRows(parsed.rows, students);
    const board = res.matches.map((m) => {
      const r = parsed.rows[m.rowIndex];
      return student({
        id: m.studentId,
        name: r.name,
        curClass: r.class,
        curNumber: r.number,
        baseScore: r.baseScore,
        gender: r.gender,
      });
    });
    const stats = overallStats(8, board, []);

    for (let cls = 1; cls <= 8; cls++) {
      const raws = parsed.rows.filter((r) => r.class === cls).map((r) => rawToX100(r.scoreRaw));
      const c = stats.classes[cls - 1];
      expect(BigInt(c.mean!), `${cls}반 평균`).toBe(meanOf(raws));
      expect(formatScore(c.mean), `${cls}반 평균 표기`).toBe(showX100(meanOf(raws)));
      const max = raws.reduce((a, b) => (b > a ? b : a));
      const min = raws.reduce((a, b) => (b < a ? b : a));
      expect([BigInt(c.max!.score), BigInt(c.min!.score)]).toEqual([max, min]);
    }
    const all = parsed.rows.map((r) => rawToX100(r.scoreRaw));
    expect(BigInt(stats.overallMean!)).toBe(meanOf(all));
    const means = stats.classes.map((c) => BigInt(c.mean!));
    const spread = means.reduce((a, b) => (b > a ? b : a)) - means.reduce((a, b) => (b < a ? b : a));
    expect(BigInt(stats.meanDiff!)).toBe(spread);
    // 경고 판정: 반 평균 차 > 학년 평균의 2%
    expect(stats.warnings.mean).toBe(spread * 100n > meanOf(all) * 2n);
  });
});
