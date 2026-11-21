/** 내보내기 전 검증(§9). error는 내보내기를 막고, warning·info는 알리기만 한다. */
import type { ClassState, Gap, Rule, Student } from "@/lib/api";
import { hasRomanLetters } from "./normalize";
import { cleanReading } from "./numbering";
import { allViolations, describeViolation } from "./separation";
import { overallStats } from "./stats";

export type IssueLevel = "error" | "warning" | "info";

export interface Issue {
  level: IssueLevel;
  message: string;
  /** 관련 학생(보드에서 찾아가기용) */
  studentIds?: number[];
}

export interface ValidateInput {
  students: Student[];
  gaps: Gap[];
  rules: Rule[];
  classStates: ClassState[];
  classCount: number;
  /** PDF를 가져왔는지 */
  hasPdf: boolean;
}

export function validateForExport(input: ValidateInput): Issue[] {
  const { students, gaps, rules, classStates, classCount, hasPdf } = input;
  const issues: Issue[] = [];
  const nameOf = (id: number) => students.find((s) => s.id === id)?.nameNorm ?? `#${id}`;

  // ❌ 차단
  for (const s of students) {
    if (s.curClass < 1 || s.curClass > classCount)
      issues.push({
        level: "error",
        message: `${s.nameNorm}: ${s.curClass}반은 없는 반입니다(1~${classCount}반).`,
        studentIds: [s.id],
      });
    if (s.curNumber < 1)
      issues.push({ level: "error", message: `${s.nameNorm}: 번호가 잘못되었습니다.`, studentIds: [s.id] });
  }
  const seats = new Map<string, string[]>();
  const seatIds = new Map<string, number[]>();
  for (const s of students) {
    const k = `${s.curClass}-${s.curNumber}`;
    seats.set(k, [...(seats.get(k) ?? []), s.nameNorm]);
    seatIds.set(k, [...(seatIds.get(k) ?? []), s.id]);
  }
  for (const g of gaps) {
    const k = `${g.class}-${g.number}`;
    seats.set(k, [...(seats.get(k) ?? []), "(빈 번호)"]);
  }
  for (const [k, names] of seats) {
    if (names.length < 2) continue;
    const [c, n] = k.split("-");
    issues.push({
      level: "error",
      message: `${c}반 ${n}번이 겹칩니다: ${names.join(", ")}`,
      studentIds: seatIds.get(k),
    });
  }

  // ⚠️ 경고
  for (const v of allViolations(rules, (id) => students.find((s) => s.id === id)?.curClass))
    issues.push({
      level: "warning",
      message: `분리 규칙 위반 — ${describeViolation(v, nameOf)}`,
      studentIds: v.studentIds,
    });

  const stats = overallStats(classCount, students, gaps);
  if (stats.warnings.count) {
    const counts = stats.classes.map((c) => `${c.cls}반 ${c.count}`).join(" · ");
    issues.push({ level: "warning", message: `반 간 인원 차가 ${stats.countDiff}명입니다. (${counts})` });
  }

  if (hasPdf) {
    const unmatched = students.filter((s) => s.matchMethod == null);
    if (unmatched.length)
      issues.push({
        level: "warning",
        message: `PDF 기준성적이 연결되지 않은 학생 ${unmatched.length}명: ${unmatched
          .slice(0, 5)
          .map((s) => s.nameNorm)
          .join(", ")}${unmatched.length > 5 ? " 외" : ""}`,
        studentIds: unmatched.map((s) => s.id),
      });
  }

  const sorted = new Set(classStates.filter((c) => c.numbering === "sorted").map((c) => c.class));
  const noReading = students.filter(
    (s) => sorted.has(s.curClass) && hasRomanLetters(s.name) && !cleanReading(s.sortName),
  );
  if (noReading.length)
    issues.push({
      level: "warning",
      message: `로마자 성명 한글 표기 미입력 ${noReading.length}명 — 가나다순 대신 반 끝에 붙었습니다: ${noReading.map((s) => `${s.curClass}반 ${s.nameNorm}`).join(", ")}`,
      studentIds: noReading.map((s) => s.id),
    });

  // ℹ️ 안내
  if (gaps.length) {
    const byClass = new Map<number, number[]>();
    for (const g of gaps) byClass.set(g.class, [...(byClass.get(g.class) ?? []), g.number]);
    const detail = [...byClass]
      .sort(([a], [b]) => a - b)
      .map(([c, ns]) => `${c}반 ${ns.sort((a, b) => a - b).join("·")}번`)
      .join(", ");
    issues.push({
      level: "info",
      message: `빈 번호 ${gaps.length}개(일부러 비운 번호, 업로드 파일에서는 결번): ${detail}`,
    });
  }
  const moved = students.filter((s) => s.curClass !== s.origClass).length;
  const renumbered = students.filter((s) => s.curClass === s.origClass && s.curNumber !== s.origNumber).length;
  issues.push({
    level: "info",
    message: `나이스 기본 편성 대비 반이 바뀐 학생 ${moved}명, 번호만 바뀐 학생 ${renumbered}명`,
  });

  return issues;
}
