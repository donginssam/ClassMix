/** 분리 규칙 위반 검사(§8.3). 꺼진 규칙은 검사하지 않는다. */
import type { Rule, RuleKind } from "@/lib/api";

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  group: "그룹형",
  one_to_many: "1:N형",
  twin: "쌍둥이",
  same_name: "동명이인",
};

export interface Violation {
  rule: Rule;
  cls: number;
  /** 같은 반에 함께 있는 규칙 대상 학생 */
  studentIds: number[];
}

/** 학생 id → 반 */
export type ClassOf = (studentId: number) => number | undefined;

/** 규칙 하나의 위반 목록 */
export function ruleViolations(rule: Rule, classOf: ClassOf): Violation[] {
  if (!rule.enabled) return [];
  const out: Violation[] = [];
  if (rule.kind === "one_to_many") {
    const leader = rule.members.find((m) => m.role === "leader");
    if (!leader) return [];
    const lc = classOf(leader.studentId);
    if (lc == null) return [];
    const same = rule.members.filter((m) => m.role !== "leader" && classOf(m.studentId) === lc).map((m) => m.studentId);
    if (same.length) out.push({ rule, cls: lc, studentIds: [leader.studentId, ...same] });
    return out;
  }
  const byClass = new Map<number, number[]>();
  for (const m of rule.members) {
    const c = classOf(m.studentId);
    if (c == null) continue;
    byClass.set(c, [...(byClass.get(c) ?? []), m.studentId]);
  }
  for (const [cls, ids] of byClass) if (ids.length > 1) out.push({ rule, cls, studentIds: ids });
  return out;
}

export function allViolations(rules: Rule[], classOf: ClassOf): Violation[] {
  return rules.flatMap((r) => ruleViolations(r, classOf));
}

/** 반 → 위반 목록 */
export function violationsByClass(violations: Violation[]): Map<number, Violation[]> {
  const m = new Map<number, Violation[]>();
  for (const v of violations) m.set(v.cls, [...(m.get(v.cls) ?? []), v]);
  return m;
}

/** 학생 → 위반 목록 */
export function violationsByStudent(violations: Violation[]): Map<number, Violation[]> {
  const m = new Map<number, Violation[]>();
  for (const v of violations) for (const id of v.studentIds) m.set(id, [...(m.get(id) ?? []), v]);
  return m;
}

/** 학생 → 그 학생이 들어 있는 켜진 규칙 */
export function rulesByStudent(rules: Rule[]): Map<number, Set<Rule>> {
  const byStudent = new Map<number, Set<Rule>>();
  for (const r of rules) {
    if (!r.enabled) continue;
    for (const mem of r.members) {
      const studentRules = byStudent.get(mem.studentId) ?? new Set<Rule>();
      studentRules.add(r);
      byStudent.set(mem.studentId, studentRules);
    }
  }
  return byStudent;
}

/**
 * 가상의 이동 뒤 "새로" 생기는 위반의 반 목록(드래그 중 미리 보기용).
 * @param overrides 학생 id → 옮겨 갈 반
 */
export function newViolationClasses(
  studentRules: ReadonlyMap<number, ReadonlySet<Rule>>,
  classOf: ClassOf,
  overrides: ReadonlyMap<number, number>,
): Set<number> {
  const affected = new Set<Rule>();
  for (const id of overrides.keys()) {
    for (const rule of studentRules.get(id) ?? []) affected.add(rule);
  }
  const after: ClassOf = (id) => overrides.get(id) ?? classOf(id);
  const key = (v: Violation) => `${v.rule.id}:${v.cls}:${[...v.studentIds].sort().join(",")}`;
  const out = new Set<number>();
  for (const rule of affected) {
    const before = new Set(ruleViolations(rule, classOf).map(key));
    for (const v of ruleViolations(rule, after)) if (!before.has(key(v))) out.add(v.cls);
  }
  return out;
}

/** 위반 설명 문구 */
export function describeViolation(v: Violation, nameOf: (id: number) => string): string {
  const names = v.studentIds.map(nameOf).join(", ");
  return `${RULE_KIND_LABEL[v.rule.kind]}: ${names} — ${v.cls}반에 함께 있음${v.rule.reason ? ` (${v.rule.reason})` : ""}`;
}
