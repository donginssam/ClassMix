import { describe, expect, it } from "vitest";
import { overallStats, THRESHOLDS } from "./stats";
import { student } from "./testBoard";

const cls = (c: number, male: number, female: number) => [
  ...Array.from({ length: male }, (_, i) =>
    student({ name: `남${c}-${i}`, curClass: c, curNumber: i + 1, gender: "남" }),
  ),
  ...Array.from({ length: female }, (_, i) =>
    student({ name: `여${c}-${i}`, curClass: c, curNumber: male + i + 1, gender: "여" }),
  ),
];

describe("성비 차", () => {
  it("반별 |남−여| 중 가장 큰 값과 그 반을 고른다", () => {
    const s = overallStats(2, [...cls(1, 18, 12), ...cls(2, 11, 19)], []);
    expect(s.genderGap).toEqual({ value: 8, cls: 2, male: 11, female: 19 });
    expect(s.warnings.gender).toBe(8 >= THRESHOLDS.genderGap);
  });

  it("경고 기준 미만이면 경고하지 않고, 성별 자료가 없으면 null", () => {
    const s = overallStats(2, [...cls(1, 15, 14), ...cls(2, 14, 15)], []);
    expect(s.genderGap?.value).toBe(1);
    expect(s.warnings.gender).toBe(false);
    const none = overallStats(1, [student({ name: "가", curClass: 1, curNumber: 1 })], []);
    expect(none.genderGap).toBeNull();
  });
});
