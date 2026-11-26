import { expect, it } from "vitest";
import { buildBoardMatrix } from "./boardMatrix";
import { gap, student } from "./testBoard";

it("uses the most crowded class for each row and puts students before gaps", () => {
  const first = student({ name: "김가람", curClass: 1, curNumber: 1 });
  const second = student({ name: "김나래", curClass: 2, curNumber: 1 });
  const conflict = gap({ class: 1, number: 1 });
  const last = gap({ class: 2, number: 3 });
  const { rows, classes } = buildBoardMatrix(2, [first, second], [conflict, last]);

  expect(rows).toEqual([
    { number: 1, units: 2 },
    { number: 2, units: 1 },
    { number: 3, units: 1 },
  ]);
  expect(classes[0].slotsByNumber.get(1)).toEqual([
    { kind: "student", number: 1, student: first },
    { kind: "gap", number: 1, gap: conflict },
  ]);
  expect(classes[1].slotsByNumber.get(3)).toEqual([{ kind: "gap", number: 3, gap: last }]);
});

it("returns no rows for an empty board", () => {
  const { rows, classes } = buildBoardMatrix(3, [], []);
  expect(rows).toEqual([]);
  expect(classes.map((c) => [c.cls, c.slotsByNumber.size])).toEqual([
    [1, 0],
    [2, 0],
    [3, 0],
  ]);
});

it("skips slots outside the class count when sizing rows", () => {
  const inside = student({ name: "김가람", curClass: 1, curNumber: 2 });
  const outside = student({ name: "김나래", curClass: 3, curNumber: 5 });
  const outsideGap = gap({ class: 0, number: 4 });
  const { rows, classes } = buildBoardMatrix(2, [inside, outside], [outsideGap]);

  expect(rows).toEqual([
    { number: 1, units: 1 },
    { number: 2, units: 1 },
  ]);
  expect(classes).toHaveLength(2);
  expect(classes[0].slotsByNumber.get(2)).toEqual([{ kind: "student", number: 2, student: inside }]);
});
