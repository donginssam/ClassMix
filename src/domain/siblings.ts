/** 쌍둥이 후보 감지(§8.3). 생년월일은 PDF를 넣었을 때만 있으므로 그때만 후보가 나온다. */
import type { Rule } from "@/lib/api";
import { hasRomanLetters } from "./normalize";

/** 한국 복성(두 글자 성). 첫 글자보다 먼저 확인한다. */
export const COMPOUND_SURNAMES = [
  "남궁",
  "제갈",
  "선우",
  "황보",
  "독고",
  "사공",
  "서문",
  "동방",
  "어금",
  "망절",
  "황목",
  "장곡",
  "소봉",
];

export interface TwinStudent {
  id: number;
  nameNorm: string;
  birthDate: string | null;
}

export type TwinGrade = "likely" | "possible";

export interface TwinCandidate {
  /** 정렬된 학생 id를 이은 값 */
  key: string;
  grade: TwinGrade;
  birthDate: string;
  studentIds: number[];
}

/** 한글 성명의 성(복성 우선). 한글 이름이 아니면 null. */
export function koreanSurname(name: string): string | null {
  const n = name.replace(/\s+/g, "");
  if (!/^[가-힣]+$/.test(n)) return null;
  const compound = COMPOUND_SURNAMES.find((s) => n.startsWith(s) && n.length >= s.length + 1);
  return compound ?? n[0];
}

/** 성이 같은지. 로마자 성명은 성-이름 순이 원칙이지만 실제 등록 순서가 일정하지 않아 공백으로 나눈 단어 중 하나라도 같으면 같다고 본다. */
export function sameSurname(a: string, b: string): boolean {
  if (hasRomanLetters(a) && hasRomanLetters(b)) {
    const wa = new Set(a.toUpperCase().split(/\s+/).filter(Boolean));
    return b
      .toUpperCase()
      .split(/\s+/)
      .some((w) => w && wa.has(w));
  }
  const sa = koreanSurname(a);
  const sb = koreanSurname(b);
  return sa != null && sa === sb;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * 같은 생년월일 학생끼리 묶어 후보를 만든다.
 * - 같은 생년월일 + 같은 성 → "유력"(세쌍둥이 이상은 한 묶음)
 * - 남은 같은 생년월일 학생 → "가능" 한 묶음
 * 모든 쌍이 "아님"으로 넘겨졌거나 이미 같은 쌍둥이 규칙에 들어 있으면 제외한다.
 */
export function twinCandidates(students: TwinStudent[], rules: Rule[], dismissed: [number, number][]): TwinCandidate[] {
  const done = new Set(dismissed.map(([a, b]) => pairKey(a, b)));
  for (const r of rules) {
    if (r.kind !== "twin") continue;
    const ids = r.members.map((m) => m.studentId);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) done.add(pairKey(ids[i], ids[j]));
  }

  const byDate = new Map<string, TwinStudent[]>();
  for (const s of students) {
    if (!s.birthDate) continue;
    byDate.set(s.birthDate, [...(byDate.get(s.birthDate) ?? []), s]);
  }

  const out: TwinCandidate[] = [];
  const push = (grade: TwinGrade, birthDate: string, group: TwinStudent[]) => {
    const ids = group.map((s) => s.id).sort((a, b) => a - b);
    let open = false;
    for (let i = 0; i < ids.length && !open; i++)
      for (let j = i + 1; j < ids.length; j++)
        if (!done.has(pairKey(ids[i], ids[j]))) {
          open = true;
          break;
        }
    if (open) out.push({ key: ids.join("-"), grade, birthDate, studentIds: ids });
  };

  for (const [date, group] of [...byDate].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < 2) continue;
    // 같은 성끼리 연결 요소로 묶는다(유니온-파인드)
    const parent = group.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        if (sameSurname(group[i].nameNorm, group[j].nameNorm)) parent[find(i)] = find(j);
    const comps = new Map<number, TwinStudent[]>();
    group.forEach((s, i) => comps.set(find(i), [...(comps.get(find(i)) ?? []), s]));
    const rest: TwinStudent[] = [];
    for (const comp of comps.values()) {
      if (comp.length > 1) push("likely", date, comp);
      else rest.push(comp[0]);
    }
    if (rest.length > 1) push("possible", date, rest);
  }
  return out.sort((a, b) => (a.grade === b.grade ? 0 : a.grade === "likely" ? -1 : 1));
}
