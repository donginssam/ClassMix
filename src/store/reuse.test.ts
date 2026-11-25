import { describe, expect, it } from "vitest";
import { student } from "@/domain/testBoard";
import { reuseList, reuseStudentPlacements, sameValue } from "./reuse";

describe("sameValue", () => {
  it("compares primitives, arrays and plain objects by content", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: 1, m: [{ id: 1 }] }, { a: 1, m: [{ id: 1 }] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue({ a: 1 }, [1])).toBe(false);
  });
});

describe("reuseList", () => {
  const a = { id: 1, c: 1 };
  const b = { id: 2, c: 2 };

  it("returns the previous array when nothing changed", () => {
    const prev = [a, b];
    expect(reuseList(prev, [{ ...a }, { ...b }], (x) => x.id)).toBe(prev);
  });

  it("keeps unchanged items and replaces changed ones", () => {
    const prev = [a, b];
    const nextB = { id: 2, c: 3 };
    const out = reuseList(prev, [{ ...a }, nextB], (x) => x.id);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(nextB);
  });

  it("detects reordering, additions and removals", () => {
    const prev = [a, b];
    const reordered = reuseList(prev, [{ ...b }, { ...a }], (x) => x.id);
    expect(reordered).not.toBe(prev);
    expect(reordered[0]).toBe(b);
    expect(reordered[1]).toBe(a);
    expect(reuseList(prev, [{ ...a }], (x) => x.id)).toEqual([a]);
    expect(reuseList(prev, [{ ...a }, { ...b }, { id: 3, c: 1 }], (x) => x.id)).toHaveLength(3);
  });
});

describe("reuseStudentPlacements", () => {
  const first = student({ id: 1, name: "가람", curClass: 1, curNumber: 1, memo: "메모" });
  const second = student({ id: 2, name: "나래", curClass: 1, curNumber: 2 });
  const previous = [first, second];
  const byId = new Map(previous.map((s) => [s.id, s]));

  it("keeps the same array when every placement is unchanged", () => {
    expect(
      reuseStudentPlacements(previous, byId, [
        [1, 1, 1, null],
        [2, 1, 2, null],
      ]),
    ).toBe(previous);
  });

  it("applies placements in server order while retaining other student values and unchanged rows", () => {
    const students = reuseStudentPlacements(previous, byId, [
      [2, 1, 2, null],
      [1, 2, 1, "가람"],
    ]);
    expect(students?.[0]).toBe(second);
    expect(students?.[1]).toEqual({ ...first, curClass: 2, curNumber: 1, sortName: "가람" });
  });

  it("requires a full roster if the projected rows do not match the current roster", () => {
    expect(reuseStudentPlacements(previous, byId, [[1, 1, 1, null]])).toBeNull();
    expect(
      reuseStudentPlacements(previous, byId, [
        [1, 1, 1, null],
        [9, 1, 2, null],
      ]),
    ).toBeNull();
  });
});
