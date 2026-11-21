/**
 * 합성한 쪽으로 표 복원 규칙을 확인한다. 실제 나이스 PDF처럼 표 아래 표준 인원 요약(`남(18)명 여(12)명 계:(30)`)과
 * 그 아래 쪽 번호(`1 / 8`)가 있는 쪽, 줄바꿈된 이름을 다룬다.
 */
import { describe, expect, it } from "vitest";
import { joinWrapped, parsePdfPages, pdfName, type PdfPage, type TextItem } from "./pdfTable";

const t = (str: string, x: number, y: number): TextItem => ({ str, x, y, width: str.length * 6, height: 10 });

const HEADER: TextItem[] = [
  t("학년", 30, 727),
  t("반", 64, 727),
  t("번호", 85, 727),
  t("성명", 126, 727),
  t("생년월일", 179, 727),
  t("성별", 241, 727),
  t("기준성적", 280, 727),
  t("이전학적", 368, 741),
  t("학년", 340, 727),
  t("반", 388, 727),
  t("번호", 418, 727),
  t("특이사항", 475, 727),
];

type RowSpec = { n: number; name: string | string[]; gender: "남" | "여" };

function page(pageNumber: number, rows: RowSpec[], footer: TextItem[]): PdfPage {
  const items = [...HEADER];
  rows.forEach((r, i) => {
    const y = 700 - i * 17;
    items.push(t("2학년", 30, y), t("1", 66, y), t(String(r.n), 90, y));
    const parts = Array.isArray(r.name) ? r.name : [r.name];
    // 두 조각이면 기준선 위·아래로 줄바꿈된 이름
    parts.forEach((p, k) => items.push(t(p, 113, parts.length === 1 ? y : y + 4 - k * 8)));
    items.push(t("2012.01.02.", 174, y), t(r.gender, 247, y), t("1,001.50", 292, y));
    items.push(t("1학년", 339, y), t("2", 385, y), t(String(r.n), 420, y));
  });
  return { pageNumber, items: [...items, ...footer] };
}

const footer = (m: number, f: number, total: number, pageNo: number, pages: number, y = 560) => [
  t(`남(${m})명`, 79, y),
  t(`여(${f})명`, 249, y),
  t(`계:(${total})`, 443, y),
  // 실제 PDF의 쪽 번호 꼬리말
  t(String(pageNo), 273, 52),
  t("/", 294, 52),
  t(String(pages), 315, 52),
];

describe("parsePdfPages", () => {
  it("reads the headcount line above a page-number footer and ignores the page number", () => {
    const res = parsePdfPages([
      page(
        1,
        [
          { n: 1, name: "가나다", gender: "남" },
          { n: 2, name: "라마바", gender: "여" },
        ],
        footer(1, 1, 2, 1, 2),
      ),
      page(2, [{ n: 1, name: "사아자", gender: "여" }], footer(0, 1, 1, 2, 2)),
    ]);
    expect(res.problems).toEqual([]);
    expect(res.rows.map((r) => [r.name, r.baseScore, r.note])).toEqual([
      ["가나다", 100150, null],
      ["라마바", 100150, null],
      ["사아자", 100150, null],
    ]);
    expect(res.pages.map((p) => [p.footer, p.ok, p.message])).toEqual([
      [{ male: 1, female: 1, total: 2 }, true, null],
      [{ male: 0, female: 1, total: 1 }, true, null],
    ]);
  });

  it("does not take the old `남(n명)` style as the standard headcount", () => {
    const res = parsePdfPages([
      page(
        1,
        [{ n: 1, name: "가나다", gender: "남" }],
        [t("남(1명)", 101, 560), t("여(0명)", 282, 560), t("계:(1)", 462, 560)],
      ),
    ]);
    expect(res.pages[0]).toMatchObject({ footer: null, message: "1쪽 아래 인원 요약을 찾지 못했습니다." });
  });

  it("warns when the headcount disagrees with the rows read", () => {
    const res = parsePdfPages([page(1, [{ n: 1, name: "가나다", gender: "남" }], footer(1, 1, 2, 1, 1))]);
    expect(res.pages[0].ok).toBe(false);
    expect(res.pages[0].message).toContain("1명");
  });

  it("joins wrapped names: Hangul glued, romanized spaced", () => {
    const res = parsePdfPages([
      page(
        1,
        [
          { n: 1, name: ["귀여운제비", "꽃"], gender: "남" },
          { n: 2, name: ["AYU LESTARI", "TOM"], gender: "여" },
          { n: 3, name: "GRACE BRIAR", gender: "남" },
        ],
        footer(2, 1, 3, 1, 1),
      ),
    ]);
    expect(res.rows.map((r) => r.name)).toEqual(["귀여운제비꽃", "AYU LESTARI TOM", "GRACE BRIAR"]);
  });
});

describe("joinWrapped", () => {
  it("glues Hangul-to-Hangul breaks only", () => {
    expect(joinWrapped(["용감한오랑", "우탄"])).toBe("용감한오랑우탄");
    expect(joinWrapped(["HANNAH CRUZ", "QU"])).toBe("HANNAH CRUZ QU");
    expect(joinWrapped(["김", "", " Tom "])).toBe("김 Tom");
  });
});

describe("pdfName", () => {
  // 한국 국적: 띄어쓰기 없는 한글 / 로마자 성명: 외국인등록증의 대문자 로마자(단어 사이 한 칸)
  it("never leaves a space inside a Hangul name, keeps one between romanized words", () => {
    expect(pdfName(["귀여운제비", "꽃"])).toBe("귀여운제비꽃");
    expect(pdfName(["용감한 오랑우탄"])).toBe("용감한오랑우탄");
    expect(pdfName(["HANNAH  CRUZ", "QU"])).toBe("HANNAH CRUZ QU");
    expect(pdfName(["GRACE BRIAR"])).toBe("GRACE BRIAR");
  });
});
