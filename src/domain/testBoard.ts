/** 테스트용 보드 만들기·변경 묶음 적용(Rust `changes::apply_in_tx`와 같은 규칙). 테스트에서만 쓴다. */
import type { ChangeSet, Gap, Student } from "@/lib/api";
import type { BoardState } from "./changes";

let nextId = 1;

export function student(p: Partial<Student> & { name: string; curClass: number; curNumber: number }): Student {
  const id = p.id ?? nextId++;
  return {
    id,
    studentNo: p.studentNo ?? `2025${String(id).padStart(6, "0")}`,
    nameNorm: p.name.replace(/\s+/g, " ").trim(),
    prevGrade: "1학년",
    prevClass: 1,
    prevNumber: id,
    origClass: p.curClass,
    origNumber: p.curNumber,
    gender: null,
    birthDate: null,
    baseScore: null,
    matchMethod: null,
    memo: null,
    sortName: null,
    sameName: false,
    ...p,
  };
}

let gapId = 1000;
export function gap(p: Partial<Gap> & { class: number; number: number }): Gap {
  return {
    id: gapId++,
    anchorKey: "",
    plannedName: null,
    origin: "manual",
    createdAt: "2026-01-01T00:00:00+09:00",
    ...p,
  };
}

/** 반별 이름 목록으로 보드를 만든다. 번호는 1부터 차례로. */
export function board(classes: string[][], extra?: { gaps?: Gap[] }): BoardState {
  const students: Student[] = [];
  classes.forEach((names, i) =>
    names.forEach((name, j) => students.push(student({ name, curClass: i + 1, curNumber: j + 1 }))),
  );
  return {
    students,
    gaps: extra?.gaps ?? [],
    classStates: classes.map((_, i) => ({ class: i + 1, numbering: "original" as const })),
    classCount: classes.length,
  };
}

/** 변경 묶음을 적용한 새 보드(바꾸기 전 값이 맞는지도 확인) */
export function apply(b: BoardState, cs: ChangeSet): BoardState {
  const students = b.students.map((s) => {
    const m = cs.students.find((x) => x.studentId === s.id);
    const r = cs.readings.find((x) => x.studentId === s.id);
    let next = s;
    if (m) {
      if (m.from.c !== s.curClass || m.from.n !== s.curNumber) throw new Error(`stale seat ${s.nameNorm}`);
      next = { ...next, curClass: m.to.c, curNumber: m.to.n };
    }
    if (r) next = { ...next, sortName: r.to };
    return next;
  });
  let gaps = b.gaps;
  for (const g of cs.gaps) {
    gaps = [
      ...gaps.filter((x) => x.class !== g.class),
      ...g.after.map((row) => ({
        id: gapId++,
        class: g.class,
        number: row.number,
        anchorKey: row.anchorKey,
        plannedName: row.plannedName,
        origin: row.origin,
        createdAt: row.createdAt ?? "",
      })),
    ];
  }
  const classStates = b.classStates.map((c) => {
    const n = cs.numbering.find((x) => x.class === c.class);
    return n ? { ...c, numbering: n.to } : c;
  });
  const next = { ...b, students, gaps, classStates };
  // 같은 반 번호 중복 검사
  const seen = new Set<string>();
  for (const k of [
    ...next.students.map((s) => `${s.curClass}-${s.curNumber}`),
    ...next.gaps.map((g) => `${g.class}-${g.number}`),
  ]) {
    if (seen.has(k)) throw new Error(`duplicate seat ${k}`);
    seen.add(k);
  }
  return next;
}

/** 반의 번호 순서를 "번호 이름" 목록으로. 빈 번호는 "n (빈)" 또는 "n (빈:예정이름)" */
export function roster(b: BoardState, cls: number): string[] {
  return [
    ...b.students.filter((s) => s.curClass === cls).map((s) => ({ n: s.curNumber, t: s.nameNorm })),
    ...b.gaps
      .filter((g) => g.class === cls)
      .map((g) => ({ n: g.number, t: g.plannedName ? `(빈:${g.plannedName})` : "(빈)" })),
  ]
    .sort((a, b) => a.n - b.n)
    .map((x) => `${x.n} ${x.t}`);
}
