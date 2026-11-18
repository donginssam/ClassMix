import { describe, expect, it } from "vitest";
import { collapseSpaces, hasRomanLetters, nameKey, toInt, toIsoDate, toScore } from "./normalize";

describe("normalize", () => {
  it("collapses whitespace", () => {
    expect(collapseSpaces("  앙꼬 ")).toBe("앙꼬");
    expect(collapseSpaces("Ayu Lestari\nTom")).toBe("Ayu Lestari Tom");
  });

  it("builds name keys ignoring spaces and case", () => {
    expect(nameKey("Ayu Lestari Tom")).toBe(nameKey("AYU LESTARI\nTOM"));
    expect(nameKey("앙꼬 ")).toBe("앙꼬");
  });

  it("parses numbers, dates and scores", () => {
    expect(toInt(" 12 ")).toBe(12);
    expect(toInt("1.5")).toBeNull();
    expect(toIsoDate("2007.11.19.")).toBe("2007-11-19");
    expect(toIsoDate("2007-1-9")).toBe("2007-01-09");
    expect(toIsoDate("전입")).toBeNull();
    expect(toScore("1001.98")).toBe(1001.98);
    expect(toScore("")).toBeNull();
  });

  it("detects roman names", () => {
    expect(hasRomanLetters("Teddy Srisuk")).toBe(true);
    expect(hasRomanLetters("라라룰라 탈룰라")).toBe(false);
  });
});
