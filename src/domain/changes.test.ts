import { describe, expect, it } from "vitest";
import {
  addGapBefore,
  editGapName,
  isEmptyChange,
  moveStudent,
  removeGap,
  renumberClasses,
  resetToOriginal,
  setNumber,
  setNumberPreview,
  setReadings,
  swapStudents,
  type BoardState,
} from "./changes";
import { compareKeys } from "./numbering";
import { apply, board, gap, roster } from "./testBoard";

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return (r as unknown as { change: Parameters<typeof apply>[1] }).change;
};
const idOf = (b: BoardState, name: string) => b.students.find((s) => s.nameNorm === name)!.id;

describe("compareKeys", () => {
  it("빈 키는 맨 앞, 로마자 키는 한글 뒤", () => {
    const keys = ["TEDDY SRISUK", "김나래", "", "홍하늘", "AYU LESTARI TOM", "응우옌"];
    expect([...keys].sort(compareKeys)).toEqual(["", "김나래", "응우옌", "홍하늘", "AYU LESTARI TOM", "TEDDY SRISUK"]);
  });
});

describe("번호 직접 수정", () => {
  const names = ["김가람", "김나래", "김다온", "김라희", "김마루", "홍하늘"];

  it("늘리면 앞에 빈 번호가 생기고 뒤 학생이 모두 밀린다", () => {
    const b = board([names]);
    const next = apply(b, ok(setNumber(b, idOf(b, "김다온"), 4)));
    expect(roster(next, 1)).toEqual(["1 김가람", "2 김나래", "3 (빈)", "4 김다온", "5 김라희", "6 김마루", "7 홍하늘"]);
    expect(next.gaps[0].anchorKey).toBe("김나래");
  });

  it("미리보기 문구", () => {
    const b = board([names]);
    expect(setNumberPreview(b, idOf(b, "김다온"), 5)).toBe(
      "3번 김다온 ~ 6번 홍하늘, 4명 번호 +2. 앞에 빈 번호 2개가 생깁니다.",
    );
  });

  it("줄이면 바로 앞 빈 번호를 지우고, 모자라면 거절한다", () => {
    const b = board([names]);
    const pushed = apply(b, ok(setNumber(b, idOf(b, "김다온"), 5)));
    const pulled = apply(pushed, ok(setNumber(pushed, idOf(pushed, "김다온"), 4)));
    expect(roster(pulled, 1).slice(0, 4)).toEqual(["1 김가람", "2 김나래", "3 (빈)", "4 김다온"]);
    const r = setNumber(pulled, idOf(pulled, "김다온"), 2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("앞 학생(2번 김나래)");
  });

  it("앞에 빈 번호 넣기 = 번호 +1", () => {
    const b = board([names]);
    const next = apply(b, ok(addGapBefore(b, idOf(b, "김가람"))));
    expect(roster(next, 1).slice(0, 2)).toEqual(["1 (빈)", "2 김가람"]);
    expect(next.gaps[0].anchorKey).toBe("");
  });

  it("빈 번호 지우기는 뒤를 당긴다", () => {
    const b = board([names]);
    const pushed = apply(b, ok(setNumber(b, idOf(b, "김다온"), 4)));
    const next = apply(pushed, ok(removeGap(pushed, pushed.gaps[0].id)));
    expect(roster(next, 1)).toEqual(names.map((n, i) => `${i + 1} ${n}`));
  });
});

describe("이동·바꾸기와 재정렬", () => {
  it("이동하면 두 반 모두 가나다순으로 재정렬되고 '가나다'가 된다", () => {
    const b = board([
      ["홍하늘", "김나래", "박다온"],
      ["이수민", "장하늘"],
    ]);
    const cs = ok(moveStudent(b, idOf(b, "김나래"), 2));
    const next = apply(b, cs);
    expect(roster(next, 1)).toEqual(["1 박다온", "2 홍하늘"]);
    expect(roster(next, 2)).toEqual(["1 김나래", "2 이수민", "3 장하늘"]);
    expect(cs.numbering.map((n) => [n.class, n.to])).toEqual([
      [1, "sorted"],
      [2, "sorted"],
    ]);
  });

  it("빈 번호는 재정렬해도 기준 학생 뒤 제자리를 지킨다", () => {
    const b = board([["김가람", "김나래", "김다온", "김라희"], ["가나다"]]);
    let s = apply(b, ok(setNumber(b, idOf(b, "김다온"), 4))); // 김나래 뒤 빈 번호
    s = apply(s, ok(moveStudent(s, idOf(s, "가나다"), 1)));
    expect(roster(s, 1)).toEqual(["1 가나다", "2 김가람", "3 김나래", "4 (빈)", "5 김다온", "6 김라희"]);
    // 기준 학생(김나래)이 다른 반으로 가도 빈 번호는 이 반의 같은 가나다 위치에 남는다
    s = apply(s, ok(moveStudent(s, idOf(s, "김나래"), 2)));
    expect(roster(s, 1)).toEqual(["1 가나다", "2 김가람", "3 (빈)", "4 김다온", "5 김라희"]);
  });

  it("예정 이름이 있는 빈 번호는 그 이름의 가나다 위치로 간다(재정렬된 반)", () => {
    const b = board([["김가람", "박나래", "최다온"]]);
    let s = apply(b, ok(renumberClasses(b, [1])));
    s = apply(s, ok(addGapBefore(s, idOf(s, "박나래"))));
    s = apply(s, ok(editGapName(s, s.gaps[0].id, "정예정")));
    expect(roster(s, 1)).toEqual(["1 김가람", "2 박나래", "3 (빈:정예정)", "4 최다온"]);
    // 이름을 지우면 원래 기준 위치로
    s = apply(s, ok(editGapName(s, s.gaps[0].id, null)));
    expect(roster(s, 1)).toEqual(["1 김가람", "2 (빈)", "3 박나래", "4 최다온"]);
  });

  it("같은 반끼리는 바꿀 수 없고, 다른 반이면 서로 자리를 바꾼다", () => {
    const b = board([["김가람", "박나래"], ["이수민"]]);
    expect(swapStudents(b, idOf(b, "김가람"), idOf(b, "박나래")).ok).toBe(false);
    const next = apply(b, ok(swapStudents(b, idOf(b, "박나래"), idOf(b, "이수민"))));
    expect(roster(next, 1)).toEqual(["1 김가람", "2 이수민"]);
    expect(roster(next, 2)).toEqual(["1 박나래"]);
  });

  it("이미 정렬된 반을 재정렬하면 바뀐 것이 없다", () => {
    const b = board([["김가람", "박나래"]]);
    const s = apply(b, ok(renumberClasses(b, [1])));
    expect(isEmptyChange(ok(renumberClasses(s, [1])))).toBe(true);
  });
});

describe("로마자 성명 한글 표기", () => {
  it("한글 표기를 넣으면 그 가나다 자리로, 없으면 반 끝", () => {
    const b = board([["TEDDY SRISUK", "김가람", "하늘", "박나래"]]);
    let s = apply(b, ok(renumberClasses(b, [1])));
    expect(roster(s, 1)).toEqual(["1 김가람", "2 박나래", "3 하늘", "4 TEDDY SRISUK"]);
    s = apply(s, ok(setReadings(s, new Map([[idOf(s, "TEDDY SRISUK"), "테디 스리숙"]]))));
    expect(roster(s, 1)).toEqual(["1 김가람", "2 박나래", "3 TEDDY SRISUK", "4 하늘"]);
    expect(s.students.find((x) => x.nameNorm === "TEDDY SRISUK")!.sortName).toBe("테디스리숙");
  });

  it("나이스 번호 그대로인 반은 번호를 건드리지 않는다", () => {
    const b = board([["TEDDY SRISUK", "김가람"]]);
    const r = setReadings(b, new Map([[idOf(b, "TEDDY SRISUK"), "테디스리숙"]]));
    expect(r.ok && r.originalClasses).toEqual([1]);
    expect(ok(r).students).toEqual([]);
  });

  it("한글이 아니면 거절", () => {
    const b = board([["TEDDY SRISUK"]]);
    expect(setReadings(b, new Map([[idOf(b, "TEDDY SRISUK"), "TEDDY"]])).ok).toBe(false);
  });

  it("기준 학생의 한글 표기가 바뀌면 빈 번호 기준 키도 따라간다", () => {
    const b = board([["김가람", "TEDDY SRISUK", "ZED"]]);
    let s = apply(b, ok(renumberClasses(b, [1])));
    s = apply(s, ok(addGapBefore(s, idOf(s, "ZED")))); // 기준: TEDDY SRISUK
    s = apply(s, ok(setReadings(s, new Map([[idOf(s, "TEDDY SRISUK"), "테디"]]))));
    expect(s.gaps[0].anchorKey).toBe("테디");
    expect(roster(s, 1)).toEqual(["1 김가람", "2 TEDDY SRISUK", "3 (빈)", "4 ZED"]);
  });
});

describe("나이스 기본 편성으로 되돌리기", () => {
  it("원래 반·번호와 원래 결번만 남긴다", () => {
    const b = board([["김가람", "박나래", "최다온"], ["이수민"]], {
      gaps: [],
    });
    // 원래 결번: 1반 2번(박나래 자리를 비워 둔 상태로 가져왔다고 가정)
    b.students = b.students.map((x) => (x.nameNorm === "최다온" ? { ...x, origNumber: 4, curNumber: 4 } : x));
    b.gaps = [gap({ class: 1, number: 3, anchorKey: "박나래", origin: "import" })];
    let s = apply(b, ok(moveStudent(b, idOf(b, "박나래"), 2)));
    s = apply(s, ok(addGapBefore(s, idOf(s, "이수민"))));
    s = apply(s, ok(resetToOriginal(s)));
    expect(roster(s, 1)).toEqual(["1 김가람", "2 박나래", "3 (빈)", "4 최다온"]);
    expect(roster(s, 2)).toEqual(["1 이수민"]);
    expect(s.gaps.every((g) => g.origin === "import")).toBe(true);
    expect(s.classStates.every((c) => c.numbering === "original")).toBe(true);
  });
});
