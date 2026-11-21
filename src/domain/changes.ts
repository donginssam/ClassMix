/**
 * 반편성 조작 → 변경 묶음(ChangeSet) 만들기. 모두 순수 함수.
 *
 * 각 조작은 "다음 상태"(학생 자리, 반별 빈 번호, 반별 번호 상태, 한글 표기)를 계산하고,
 * `diff`가 지금 상태와 비교해 바뀐 것만 전·후 값과 함께 담는다. Rust는 이것을 그대로 적용·기록하고,
 * 되돌리기는 전·후를 뒤집어 적용한다.
 */
import type { ChangeAction, ChangeSet, ClassState, Gap, GapRow, Numbering, Student } from "@/lib/api";
import {
  cleanReading,
  currentSlots,
  isHangulOnly,
  numberSlots,
  setStudentNumber,
  sortKeyOf,
  sortedSlots,
  type Slot,
} from "./numbering";

export interface BoardState {
  students: Student[];
  gaps: Gap[];
  classStates: ClassState[];
  classCount: number;
}

type GapLike = GapRow;
type Result = { ok: true; change: ChangeSet } | { ok: false; error: string };

interface Next {
  /** 학생 id → 새 자리 */
  seats: Map<number, { c: number; n: number }>;
  /** 반 → 새 빈 번호 목록(바뀐 반만) */
  gaps: Map<number, GapLike[]>;
  numbering: Map<number, Numbering>;
  readings: Map<number, string | null>;
}

function emptyNext(): Next {
  return { seats: new Map(), gaps: new Map(), numbering: new Map(), readings: new Map() };
}

function toRow(g: Gap | GapLike): GapLike {
  return {
    number: g.number,
    anchorKey: g.anchorKey,
    plannedName: g.plannedName,
    origin: g.origin,
    createdAt: g.createdAt ?? null,
  };
}

export function numberingOf(board: BoardState, cls: number): Numbering {
  return board.classStates.find((c) => c.class === cls)?.numbering ?? "original";
}

function sameGaps(a: GapLike[], b: GapLike[]): boolean {
  const key = (g: GapLike) => `${g.number}\u0000${g.anchorKey}\u0000${g.plannedName ?? ""}\u0000${g.origin}`;
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** 다음 상태와 지금 상태를 비교해 변경 묶음을 만든다. */
export function diff(board: BoardState, next: Next, action: ChangeAction, label: string): ChangeSet {
  const byId = new Map(board.students.map((s) => [s.id, s]));
  const students: ChangeSet["students"] = [];
  for (const [id, to] of next.seats) {
    const s = byId.get(id)!;
    if (s.curClass !== to.c || s.curNumber !== to.n)
      students.push({ studentId: id, from: { c: s.curClass, n: s.curNumber }, to });
  }
  const gaps: ChangeSet["gaps"] = [];
  for (const [cls, after] of next.gaps) {
    const before = board.gaps.filter((g) => g.class === cls).map(toRow);
    if (!sameGaps(before, after)) gaps.push({ class: cls, before, after });
  }
  const numbering: ChangeSet["numbering"] = [];
  for (const [cls, to] of next.numbering) {
    const from = numberingOf(board, cls);
    if (from !== to) numbering.push({ class: cls, from, to });
  }
  const readings: ChangeSet["readings"] = [];
  for (const [id, to] of next.readings) {
    const from = cleanReading(byId.get(id)!.sortName);
    if (from !== to) readings.push({ studentId: id, from, to });
  }
  return { action, label, students, gaps, numbering, readings };
}

export function isEmptyChange(cs: ChangeSet): boolean {
  return cs.students.length + cs.gaps.length + cs.numbering.length + cs.readings.length === 0;
}

/**
 * 반 하나를 가나다순으로 재정렬해 next에 기록한다.
 * @param members 재정렬 후 이 반에 들어갈 학생(한글 표기 변경 반영된 값)
 */
function resortInto(next: Next, cls: number, members: Student[], gaps: GapLike[]) {
  keepOrderInto(next, cls, sortedSlots(members, gaps));
  next.numbering.set(cls, "sorted");
}

function classMembers(board: BoardState, cls: number): Student[] {
  return board.students.filter((s) => s.curClass === cls);
}

function classGaps(board: BoardState, cls: number): GapLike[] {
  return board.gaps.filter((g) => g.class === cls).map(toRow);
}

function slotsOf(board: BoardState, cls: number): Slot<Student, GapLike>[] {
  return currentSlots(classMembers(board, cls), classGaps(board, cls));
}

/** 칸 목록을 그대로(순서 유지) 번호만 다시 매겨 next에 기록한다. */
function keepOrderInto(next: Next, cls: number, slots: Slot<Student, GapLike>[]) {
  const { seats, gaps } = numberSlots(slots);
  for (const [id, n] of seats) next.seats.set(id, { c: cls, n });
  next.gaps.set(cls, gaps.map(toRow));
}

const name = (s: Student) => s.nameNorm;

// ───────────── 조작 ─────────────

/** 다른 반으로 이동. 나간 반·들어간 반은 가나다순으로 재정렬한다. */
export function moveStudent(board: BoardState, studentId: number, toClass: number): Result {
  const s = board.students.find((x) => x.id === studentId);
  if (!s) return { ok: false, error: "학생을 찾을 수 없습니다." };
  if (toClass < 1 || toClass > board.classCount) return { ok: false, error: "없는 반입니다." };
  if (s.curClass === toClass) return { ok: false, error: "이미 그 반에 있습니다." };
  const next = emptyNext();
  resortInto(
    next,
    s.curClass,
    classMembers(board, s.curClass).filter((x) => x.id !== s.id),
    classGaps(board, s.curClass),
  );
  resortInto(next, toClass, [...classMembers(board, toClass), s], classGaps(board, toClass));
  return { ok: true, change: diff(board, next, "move", `${name(s)} ${s.curClass}반 → ${toClass}반`) };
}

/** 두 학생 바꾸기(서로 다른 반). 두 반 모두 가나다순으로 재정렬한다. */
export function swapStudents(board: BoardState, aId: number, bId: number): Result {
  const a = board.students.find((x) => x.id === aId);
  const b = board.students.find((x) => x.id === bId);
  if (!a || !b) return { ok: false, error: "학생을 찾을 수 없습니다." };
  if (a.curClass === b.curClass) return { ok: false, error: "같은 반 학생끼리는 바꿀 수 없습니다." };
  const next = emptyNext();
  resortInto(
    next,
    a.curClass,
    [...classMembers(board, a.curClass).filter((x) => x.id !== a.id), b],
    classGaps(board, a.curClass),
  );
  resortInto(
    next,
    b.curClass,
    [...classMembers(board, b.curClass).filter((x) => x.id !== b.id), a],
    classGaps(board, b.curClass),
  );
  return {
    ok: true,
    change: diff(board, next, "swap", `${name(a)}(${a.curClass}반) ↔ ${name(b)}(${b.curClass}반)`),
  };
}

/** 반(들)을 가나다순으로 재정렬 */
export function renumberClasses(board: BoardState, classes: number[]): Result {
  const next = emptyNext();
  for (const cls of classes) resortInto(next, cls, classMembers(board, cls), classGaps(board, cls));
  const label =
    classes.length === board.classCount ? "전체 반 가나다순 재정렬" : `${classes.join("·")}반 가나다순 재정렬`;
  return { ok: true, change: diff(board, next, "renumber", label) };
}

function newGap(anchorKey: string): GapLike {
  return { number: 0, anchorKey, plannedName: null, origin: "manual", createdAt: null };
}

/** 번호 직접 수정(앞에 빈 번호를 넣어 밀거나, 앞의 빈 번호를 지워 당김) */
export function setNumber(board: BoardState, studentId: number, newNumber: number): Result {
  const s = board.students.find((x) => x.id === studentId);
  if (!s) return { ok: false, error: "학생을 찾을 수 없습니다." };
  const r = setStudentNumber(slotsOf(board, s.curClass), studentId, newNumber, newGap);
  if (!r.ok) return r;
  const next = emptyNext();
  keepOrderInto(next, s.curClass, r.slots);
  const label = `${name(s)} ${s.curClass}반 ${s.curNumber}번 → ${newNumber}번`;
  return { ok: true, change: diff(board, next, "set_number", label) };
}

/** 번호 수정 미리보기 문구. 예) "16번 김라희 ~ 29번 홍하늘, 14명 번호 +1" */
export function setNumberPreview(board: BoardState, studentId: number, newNumber: number): string | null {
  const s = board.students.find((x) => x.id === studentId);
  if (!s) return null;
  const r = setStudentNumber(slotsOf(board, s.curClass), studentId, newNumber, newGap);
  if (!r.ok) return r.error;
  if (r.delta === 0) return "번호가 그대로입니다.";
  const first = r.shifted[0];
  const last = r.shifted[r.shifted.length - 1];
  const range =
    first === last
      ? `${first.curNumber}번 ${name(first)}`
      : `${first.curNumber}번 ${name(first)} ~ ${last.curNumber}번 ${name(last)}`;
  const sign = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
  const gapText = r.delta > 0 ? `앞에 빈 번호 ${r.delta}개가 생깁니다.` : `앞의 빈 번호 ${-r.delta}개가 지워집니다.`;
  return `${range}, ${r.shifted.length}명 번호 ${sign}. ${gapText}`;
}

/** 학생 앞에 빈 번호 1칸 넣기 */
export function addGapBefore(board: BoardState, studentId: number): Result {
  const s = board.students.find((x) => x.id === studentId);
  if (!s) return { ok: false, error: "학생을 찾을 수 없습니다." };
  const r = setNumber(board, studentId, s.curNumber + 1);
  if (!r.ok) return r;
  return {
    ok: true,
    change: { ...r.change, action: "gap_add", label: `${s.curClass}반 ${name(s)} 앞에 빈 번호 넣기` },
  };
}

/** 빈 번호 지우기(뒤 칸이 1씩 당겨짐) */
export function removeGap(board: BoardState, gapId: number): Result {
  const g = board.gaps.find((x) => x.id === gapId);
  if (!g) return { ok: false, error: "빈 번호를 찾을 수 없습니다." };
  const slots = slotsOf(board, g.class).filter((s) => !(s.kind === "gap" && s.gap.number === g.number));
  const next = emptyNext();
  keepOrderInto(next, g.class, slots);
  return { ok: true, change: diff(board, next, "gap_remove", `${g.class}반 ${g.number}번 빈 번호 지우기`) };
}

/**
 * 빈 번호의 전입 예정 이름 바꾸기. 재정렬된 반이면 예정 이름의 가나다 위치로 옮긴다.
 * 나이스 번호 그대로인 반은 번호를 건드리지 않는다(재정렬할 때 반영).
 */
export function editGapName(board: BoardState, gapId: number, plannedName: string | null): Result {
  const g = board.gaps.find((x) => x.id === gapId);
  if (!g) return { ok: false, error: "빈 번호를 찾을 수 없습니다." };
  const planned = plannedName?.trim() ? plannedName.trim() : null;
  const gaps = classGaps(board, g.class).map((row) =>
    row.number === g.number ? { ...row, plannedName: planned } : row,
  );
  const next = emptyNext();
  if (numberingOf(board, g.class) === "sorted") resortInto(next, g.class, classMembers(board, g.class), gaps);
  else next.gaps.set(g.class, gaps);
  const label = planned ? `${g.class}반 빈 번호 예정 이름 "${planned}"` : `${g.class}반 빈 번호 예정 이름 지우기`;
  return { ok: true, change: diff(board, next, "gap_edit", label) };
}

/**
 * 로마자 성명의 한글 표기 입력·수정(여러 명 한꺼번에 가능).
 * 재정렬된 반은 바로 다시 정렬하고, 그 학생을 기준으로 만든 빈 번호의 위치 키도 새 표기로 바꾼다.
 */
export function setReadings(
  board: BoardState,
  readings: Map<number, string | null>,
): Result & { originalClasses?: number[] } {
  const next = emptyNext();
  const byId = new Map(board.students.map((s) => [s.id, s]));
  const touched = new Set<number>();
  const updated = new Map<number, Student>();
  for (const [id, raw] of readings) {
    const s = byId.get(id);
    if (!s) return { ok: false, error: "학생을 찾을 수 없습니다." };
    const to = cleanReading(raw);
    if (to && !isHangulOnly(to)) return { ok: false, error: `${name(s)}: 한글만 입력할 수 있습니다.` };
    if (to === cleanReading(s.sortName)) continue;
    next.readings.set(id, to);
    updated.set(id, { ...s, sortName: to });
    touched.add(s.curClass);
  }
  if (next.readings.size === 0) return { ok: true, change: diff(board, next, "set_reading", "") };

  const originalClasses: number[] = [];
  for (const cls of touched) {
    // 이 반에서 한글 표기가 바뀐 학생을 기준으로 만든 빈 번호는 새 키를 따라간다.
    const keyChange = new Map<string, string>();
    for (const s of classMembers(board, cls)) {
      const u = updated.get(s.id);
      if (u) keyChange.set(sortKeyOf(s), sortKeyOf(u));
    }
    const gaps = classGaps(board, cls).map((g) =>
      keyChange.has(g.anchorKey) ? { ...g, anchorKey: keyChange.get(g.anchorKey)! } : g,
    );
    const members = classMembers(board, cls).map((s) => updated.get(s.id) ?? s);
    if (numberingOf(board, cls) === "sorted") resortInto(next, cls, members, gaps);
    else {
      next.gaps.set(cls, gaps);
      originalClasses.push(cls);
    }
  }
  const names = [...updated.values()];
  const label =
    names.length === 1
      ? `${name(names[0])} 한글 표기 "${cleanReading(names[0].sortName) ?? "(없음)"}"`
      : `한글 표기 ${names.length}명 입력`;
  return { ok: true, change: diff(board, next, "set_reading", label), originalClasses };
}

/**
 * 나이스 기본 편성으로 되돌리기: 모든 학생을 원래 반·번호로, 모든 반을 '나이스 번호 그대로'로,
 * 빈 번호는 원래 결번만 남긴다(직접 만든 빈 번호는 지워짐). 한글 표기·메모는 그대로 둔다.
 */
export function resetToOriginal(board: BoardState): Result {
  const next = emptyNext();
  for (const s of board.students) next.seats.set(s.id, { c: s.origClass, n: s.origNumber });
  for (let cls = 1; cls <= board.classCount; cls++) {
    next.numbering.set(cls, "original");
    const members = board.students.filter((s) => s.origClass === cls).sort((a, b) => a.origNumber - b.origNumber);
    const gaps: GapLike[] = [];
    let nextNumber = 1;
    let anchorKey = "";
    for (const student of members) {
      for (; nextNumber < student.origNumber; nextNumber++) {
        gaps.push({ number: nextNumber, anchorKey, plannedName: null, origin: "import", createdAt: null });
      }
      nextNumber = Math.max(nextNumber, student.origNumber + 1);
      anchorKey = sortKeyOf(student);
    }
    next.gaps.set(cls, gaps);
  }
  return { ok: true, change: diff(board, next, "reset", "나이스 기본 편성으로 되돌리기") };
}
