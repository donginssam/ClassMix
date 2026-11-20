import { describe, expect, it } from "vitest";
import { collapseSpaces, hasRomanLetters, nameKey, toInt, toIsoDate, toBaseScore } from "./normalize";

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
    expect(toIsoDate("미상")).toBeNull();
    expect(toBaseScore("1001.98")).toBe(100198);
    expect(toBaseScore("1,073.89")).toBe(107389);
    expect(toBaseScore("382.3")).toBe(38230);
    expect(toBaseScore("500")).toBe(50000);
    expect(toBaseScore("0.07")).toBe(7);
    expect(toBaseScore("1.005")).toBeNull();
    expect(toBaseScore("10,73.89")).toBeNull();
    expect(toBaseScore("")).toBeNull();
  });

  it("detects roman names", () => {
    expect(hasRomanLetters("Teddy Srisuk")).toBe(true);
    expect(hasRomanLetters("라라룰라 탈룰라")).toBe(false);
  });
});
