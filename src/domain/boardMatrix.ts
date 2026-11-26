import type { Gap, Student } from "@/lib/api";

export type ClassSlot =
  { kind: "student"; number: number; student: Student } | { kind: "gap"; number: number; gap: Gap };

export interface MatrixRow {
  number: number;
  /** 이 번호 줄의 칸 수(보통 1) */
  units: number;
}

/** 반별 칸을 번호로 묶고, 같은 번호의 행 높이를 칸이 가장 많은 반에 맞춘다. */
export function buildBoardMatrix(classCount: number, students: readonly Student[], gaps: readonly Gap[]) {
  const classes = Array.from({ length: classCount }, (_, i) => ({
    cls: i + 1,
    slotsByNumber: new Map<number, ClassSlot[]>(),
  }));
  const unitsByNumber = new Map<number, number>();
  let lastNumber = 0;

  const put = (cls: number, slot: ClassSlot) => {
    const byNumber = classes[cls - 1]?.slotsByNumber;
    if (!byNumber) return;
    const slots = byNumber.get(slot.number) ?? [];
    slots.push(slot);
    byNumber.set(slot.number, slots);
    unitsByNumber.set(slot.number, Math.max(unitsByNumber.get(slot.number) ?? 0, slots.length));
    lastNumber = Math.max(lastNumber, slot.number);
  };

  // 같은 반·번호를 공유하면 학생을 빈 번호보다 먼저 표시한다.
  for (const student of students) put(student.curClass, { kind: "student", number: student.curNumber, student });
  for (const gap of gaps) put(gap.class, { kind: "gap", number: gap.number, gap });

  const rows: MatrixRow[] = Array.from({ length: lastNumber }, (_, i) => ({
    number: i + 1,
    units: unitsByNumber.get(i + 1) ?? 1,
  }));
  return { classes, rows };
}
