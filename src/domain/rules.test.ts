import { describe, expect, it } from "vitest";
import type { Rule } from "@/lib/api";
import { allViolations, newViolationClasses, ruleViolations } from "./separation";
import { koreanSurname, sameSurname, twinCandidates } from "./siblings";
import { board, gap, student } from "./testBoard";
import { validateForExport } from "./validate";

const rule = (p: Partial<Rule> & { members: Rule["members"] }): Rule => ({
  id: 1,
  kind: "group",
  origin: "manual",
  enabled: true,
  reason: null,
  createdAt: "",
  ...p,
});
const m = (id: number, role: "member" | "leader" = "member") => ({ studentId: id, role });

describe("분리 규칙 위반", () => {
  const cls = new Map([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 1],
  ]);
  const classOf = (id: number) => cls.get(id);

  it("그룹형: 같은 반 두 명 이상이면 위반", () => {
    const v = ruleViolations(rule({ members: [m(1), m(2), m(3)] }), classOf);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ cls: 1, studentIds: [1, 2] });
  });

  it("1:N형: 기준과 같은 반인 학생만, 나머지끼리는 무관", () => {
    const r = rule({ kind: "one_to_many", members: [m(3, "leader"), m(1), m(2)] });
    expect(ruleViolations(r, classOf)).toEqual([]);
    const r2 = rule({ kind: "one_to_many", members: [m(1, "leader"), m(2), m(3), m(4)] });
    expect(ruleViolations(r2, classOf)[0].studentIds).toEqual([1, 2, 4]);
  });

  it("꺼진 규칙은 검사하지 않는다", () => {
    expect(allViolations([rule({ enabled: false, members: [m(1), m(2)] })], classOf)).toEqual([]);
  });

  it("드래그 미리 보기: 새로 생기는 위반의 반만", () => {
    const rules = [rule({ members: [m(1), m(3)] })];
    expect([...newViolationClasses(rules, classOf, new Map([[3, 1]]))]).toEqual([1]);
    expect([...newViolationClasses(rules, classOf, new Map([[3, 3]]))]).toEqual([]);
  });
});

describe("쌍둥이 후보", () => {
  it("복성을 먼저 본다", () => {
    expect(koreanSurname("남궁민수")).toBe("남궁");
    expect(koreanSurname("남민수")).toBe("남");
    expect(koreanSurname("Teddy")).toBeNull();
    expect(sameSurname("NGUYEN VAN AN", "Nguyen Thi Hoa")).toBe(true);
    expect(sameSurname("김하나", "Kim Hana")).toBe(false);
  });

  const s = (id: number, nameNorm: string, birthDate: string | null) => ({ id, nameNorm, birthDate });

  it("같은 생일+같은 성은 유력(세쌍둥이 한 묶음), 나머지는 가능", () => {
    const list = [
      s(1, "김하나", "2010-03-01"),
      s(2, "김두리", "2010-03-01"),
      s(3, "김세찌", "2010-03-01"),
      s(4, "박다른", "2010-03-01"),
      s(5, "최우연", "2010-03-01"),
      s(6, "이혼자", "2010-05-05"),
      s(7, "생일없음", null),
    ];
    const c = twinCandidates(list, [], []);
    expect(c.map((x) => [x.grade, x.studentIds])).toEqual([
      ["likely", [1, 2, 3]],
      ["possible", [4, 5]],
    ]);
  });

  it("'아님'으로 넘긴 쌍과 이미 등록한 쌍둥이는 다시 묻지 않는다", () => {
    const list = [
      s(1, "김하나", "2010-03-01"),
      s(2, "김두리", "2010-03-01"),
      s(3, "박셋", "2010-04-01"),
      s(4, "최넷", "2010-04-01"),
    ];
    const twin = rule({ kind: "twin", members: [m(1), m(2)] });
    expect(twinCandidates(list, [twin], [[3, 4]])).toEqual([]);
  });
});

describe("내보내기 검증", () => {
  it("번호 중복은 오류, 빈 번호는 안내, 발음 미입력은 경고", () => {
    const b = board([["김가람", "Teddy Srisuk"]]);
    b.classStates = [{ class: 1, numbering: "sorted" }];
    b.students.push(student({ name: "중복이", curClass: 1, curNumber: 2 }));
    const issues = validateForExport({
      students: b.students,
      gaps: [gap({ class: 1, number: 4 })],
      rules: [],
      classStates: b.classStates,
      classCount: 1,
      hasPdf: false,
    });
    expect(issues.filter((i) => i.level === "error").map((i) => i.message)).toEqual([
      "1반 2번이 겹칩니다: Teddy Srisuk, 중복이",
    ]);
    expect(issues.some((i) => i.level === "warning" && i.message.startsWith("한글 발음 미입력 1명"))).toBe(true);
    expect(issues.some((i) => i.level === "info" && i.message.startsWith("빈 번호 1개"))).toBe(true);
  });

  it("범위 밖 반과 반 간 인원 차를 알린다", () => {
    const b = board([["가", "나", "다"], ["라"]]);
    b.students[0] = { ...b.students[0], curClass: 3 };
    const issues = validateForExport({ ...b, rules: [], hasPdf: false });
    expect(issues.some((i) => i.level === "error" && i.message.includes("3반은 없는 반"))).toBe(true);
  });
});
