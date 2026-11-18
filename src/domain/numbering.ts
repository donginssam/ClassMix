/**
 * 반 내 번호 계산(§8.5, §8.6).
 *
 * 반의 번호 순서는 "학생"과 "빈 번호" 칸이 섞인 목록이고, 번호는 목록 위치에서 나온다.
 * - 재정렬: 학생은 정렬 키(한글 발음 또는 성명)로 가나다순, 빈 번호는 자기 위치 키로 그 사이에 들어간다.
 * - 번호 직접 수정: 순서는 그대로 두고 학생 바로 앞에 빈 번호 칸을 넣거나 뺀다.
 *
 * 학교별 번호 규칙을 나중에 넣을 때는 `compareStudents`만 바꾸면 된다.
 */
import { hasRomanLetters } from "./normalize";

export interface NumberingStudent {
  id: number;
  studentNo: string;
  name: string;
  nameNorm: string;
  sortName: string | null;
}

export interface NumberingGap {
  number: number;
  anchorKey: string;
  plannedName: string | null;
  origin: "manual" | "import";
  createdAt?: string | null;
}

export type Slot<S extends NumberingStudent = NumberingStudent, G extends NumberingGap = NumberingGap> =
  { kind: "student"; student: S } | { kind: "gap"; gap: G };

const collator = new Intl.Collator("ko", { sensitivity: "base", numeric: true });

/** 한글 발음 입력값 정리: 공백을 모두 지운다. 비면 null. */
export function cleanReading(s: string | null | undefined): string | null {
  const v = (s ?? "").replace(/\s+/g, "");
  return v === "" ? null : v;
}

/** 한글(완성형)만으로 된 값인지 */
export function isHangulOnly(s: string): boolean {
  return /^[가-힣]+$/.test(s);
}

/** 학생의 정렬 키: 한글 발음이 있으면 그것, 없으면 성명(공백 정리). */
export function sortKeyOf(s: Pick<NumberingStudent, "nameNorm" | "sortName">): string {
  return cleanReading(s.sortName) ?? s.nameNorm;
}

/** 빈 번호의 위치 키: 예정 이름이 있으면 그 이름, 없으면 만들 때 바로 앞 학생의 키. */
export function gapKeyOf(g: Pick<NumberingGap, "anchorKey" | "plannedName">): string {
  return cleanReading(g.plannedName) ?? g.anchorKey;
}

/**
 * 정렬 키 비교. 로마자가 섞인 키(발음을 아직 넣지 않은 외국 국적 학생)는 한글 이름 뒤에 알파벳순으로 둔다.
 * 빈 키('')는 맨 앞.
 */
export function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  const ra = hasRomanLetters(a) ? 1 : 0;
  const rb = hasRomanLetters(b) ? 1 : 0;
  if (ra !== rb) return ra - rb;
  return collator.compare(a, b);
}

/** 학생 정렬 기준(가나다순, 같으면 학번순). */
export function compareStudents(a: NumberingStudent, b: NumberingStudent): number {
  return (
    compareKeys(sortKeyOf(a), sortKeyOf(b)) || (a.studentNo < b.studentNo ? -1 : a.studentNo > b.studentNo ? 1 : 0)
  );
}

/** 현재 번호 순서의 칸 목록(학생·빈 번호 섞임). 번호가 같으면 학생 먼저. */
export function currentSlots<S extends NumberingStudent & { curNumber: number }, G extends NumberingGap>(
  students: S[],
  gaps: G[],
): Slot<S, G>[] {
  const items: { n: number; order: number; slot: Slot<S, G> }[] = [
    ...students.map((s) => ({ n: s.curNumber, order: 0, slot: { kind: "student" as const, student: s } })),
    ...gaps.map((g) => ({ n: g.number, order: 1, slot: { kind: "gap" as const, gap: g } })),
  ];
  items.sort((a, b) => a.n - b.n || a.order - b.order);
  return items.map((i) => i.slot);
}

/** 가나다순 재정렬한 칸 목록. */
export function sortedSlots<S extends NumberingStudent, G extends NumberingGap>(
  students: S[],
  gaps: G[],
): Slot<S, G>[] {
  type Item = { key: string; slot: Slot<S, G>; tie: number };
  const items: Item[] = [
    ...students.map((s) => ({ key: sortKeyOf(s), slot: { kind: "student" as const, student: s }, tie: 0 })),
    ...gaps.map((g) => ({ key: gapKeyOf(g), slot: { kind: "gap" as const, gap: g }, tie: g.number })),
  ];
  items.sort((a, b) => {
    const k = compareKeys(a.key, b.key);
    if (k !== 0) return k;
    // 키가 같으면 학생 먼저(빈 번호는 기준 학생 바로 뒤)
    if (a.slot.kind !== b.slot.kind) return a.slot.kind === "student" ? -1 : 1;
    if (a.slot.kind === "student" && b.slot.kind === "student") return compareStudents(a.slot.student, b.slot.student);
    return a.tie - b.tie;
  });
  return items.map((i) => i.slot);
}

export interface Numbered<G> {
  /** 학생 id → 번호 */
  seats: Map<number, number>;
  /** 번호를 다시 매긴 빈 번호 */
  gaps: (G & { number: number })[];
}

/** 칸 목록에 1번부터 차례로 번호를 매긴다. 빈 번호도 번호 하나를 차지한다. */
export function numberSlots<S extends NumberingStudent, G extends NumberingGap>(slots: Slot<S, G>[]): Numbered<G> {
  const seats = new Map<number, number>();
  const gaps: (G & { number: number })[] = [];
  slots.forEach((slot, i) => {
    if (slot.kind === "student") seats.set(slot.student.id, i + 1);
    else gaps.push({ ...slot.gap, number: i + 1 });
  });
  return { seats, gaps };
}

/** 칸 목록에서 index 앞쪽으로 가장 가까운 학생 */
export function previousStudent<S extends NumberingStudent, G extends NumberingGap>(
  slots: Slot<S, G>[],
  index: number,
): { student: S; number: number } | null {
  for (let i = index - 1; i >= 0; i--) {
    const s = slots[i];
    if (s.kind === "student") return { student: s.student, number: i + 1 };
  }
  return null;
}

export type SetNumberResult<S extends NumberingStudent, G extends NumberingGap> =
  { ok: true; slots: Slot<S, G>[]; delta: number; shifted: S[] } | { ok: false; error: string };

/**
 * 번호 직접 수정. 번호를 늘리면 그 학생 앞에 빈 번호를 넣어 뒤 학생들을 밀고,
 * 줄이면 바로 앞의 빈 번호를 지워 당긴다. 학생 순서는 바뀌지 않는다.
 */
export function setStudentNumber<S extends NumberingStudent, G extends NumberingGap>(
  slots: Slot<S, G>[],
  studentId: number,
  newNumber: number,
  makeGap: (anchorKey: string) => G,
): SetNumberResult<S, G> {
  const idx = slots.findIndex((s) => s.kind === "student" && s.student.id === studentId);
  if (idx < 0) return { ok: false, error: "학생을 찾을 수 없습니다." };
  if (!Number.isInteger(newNumber) || newNumber < 1) return { ok: false, error: "1 이상의 정수를 입력해 주세요." };
  const cur = idx + 1;
  const delta = newNumber - cur;
  const shifted = slots.slice(idx).flatMap((s) => (s.kind === "student" ? [s.student] : []));
  if (delta === 0) return { ok: true, slots, delta, shifted };

  if (delta > 0) {
    const prev = previousStudent(slots, idx);
    const anchor = prev ? sortKeyOf(prev.student) : "";
    const inserted: Slot<S, G>[] = Array.from({ length: delta }, () => ({
      kind: "gap" as const,
      gap: makeGap(anchor),
    }));
    return { ok: true, slots: [...slots.slice(0, idx), ...inserted, ...slots.slice(idx)], delta, shifted };
  }

  let free = 0;
  for (let i = idx - 1; i >= 0 && slots[i].kind === "gap"; i--) free++;
  if (free < -delta) {
    const prev = previousStudent(slots, idx);
    return {
      ok: false,
      error: prev
        ? `앞 학생(${prev.number}번 ${prev.student.nameNorm})보다 작게 할 수 없습니다. ${prev.number + 1}번까지 줄일 수 있습니다.`
        : `${cur - free}번보다 작게 할 수 없습니다.`,
    };
  }
  return { ok: true, slots: [...slots.slice(0, idx + delta), ...slots.slice(idx)], delta, shifted };
}
