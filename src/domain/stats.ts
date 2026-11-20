/**
 * 반별·전체 통계(§8.2).
 * 점수는 모두 100배 정수(0.01점 단위)로 계산한다. 평균도 정수 반올림(0.5 올림)으로 100배 정수를 만들어,
 * 실행 환경의 부동소수점 처리와 관계없이 같은 값이 나온다.
 */
import type { Gap, Student } from "@/lib/api";
import { roundDiv } from "@/lib/format";

/** 100배 정수 점수들의 평균(100배 정수, 반올림). 없으면 null. */
export function meanScore(scores: number[]): number | null {
  if (!scores.length) return null;
  const sum = scores.reduce((a, b) => a + b, 0);
  return sum >= 0 ? roundDiv(sum, scores.length) : -roundDiv(-sum, scores.length);
}

export interface ClassStats {
  cls: number;
  count: number;
  male: number;
  female: number;
  /** 이전 n반 → 인원 */
  prevDist: Map<number, number>;
  scoreCount: number;
  /** 반 평균(100배 정수) */
  mean: number | null;
  /** 최고·최저 기준성적(100배 정수) */
  max: { score: number; name: string } | null;
  min: { score: number; name: string } | null;
  lastNumber: number;
  gapCount: number;
  /** 나이스 기본 편성과 다른 반에 있는 학생 수 */
  movedIn: number;
}

export interface OverallStats {
  classes: ClassStats[];
  total: number;
  /** 이전 반 목록(오름차순) */
  prevClasses: number[];
  countDiff: number;
  /** 반 평균 최대−최소(100배 정수) */
  meanDiff: number | null;
  /** 성비 차: 반별 남녀 인원 차(|남−여|) 중 가장 큰 값과 그 반. 성별 자료(PDF)가 없으면 null */
  genderGap: { value: number; cls: number; male: number; female: number } | null;
  /** 학년 평균(100배 정수) */
  overallMean: number | null;
  warnings: { count: boolean; mean: boolean; gender: boolean };
}

/** 경고 기준 */
export const THRESHOLDS = {
  /** 반 간 인원 차 */
  countDiff: 2,
  /** 반 평균 성적 차(학년 평균 대비 %, 정수) */
  meanDiffPercent: 2,
  /** 성비 차(반별 |남−여|의 최댓값, 명) */
  genderGap: 4,
};

export function classStats(cls: number, students: Student[], gaps: Gap[]): ClassStats {
  const members = students.filter((s) => s.curClass === cls);
  const prevDist = new Map<number, number>();
  for (const s of members) prevDist.set(s.prevClass, (prevDist.get(s.prevClass) ?? 0) + 1);
  const scored = members.filter((s) => s.baseScore != null);
  const scores = scored.map((s) => s.baseScore!);
  const mean = meanScore(scores);
  let max: ClassStats["max"] = null;
  let min: ClassStats["min"] = null;
  for (const s of scored) {
    if (!max || s.baseScore! > max.score) max = { score: s.baseScore!, name: s.nameNorm };
    if (!min || s.baseScore! < min.score) min = { score: s.baseScore!, name: s.nameNorm };
  }
  return {
    cls,
    count: members.length,
    male: members.filter((s) => s.gender === "남").length,
    female: members.filter((s) => s.gender === "여").length,
    prevDist,
    scoreCount: scores.length,
    mean,
    max,
    min,
    lastNumber: members.reduce((m, s) => Math.max(m, s.curNumber), 0),
    gapCount: gaps.filter((g) => g.class === cls).length,
    movedIn: members.filter((s) => s.origClass !== cls).length,
  };
}

export function overallStats(classCount: number, students: Student[], gaps: Gap[]): OverallStats {
  const classes = Array.from({ length: classCount }, (_, i) => classStats(i + 1, students, gaps));
  const counts = classes.map((c) => c.count);
  const means = classes.flatMap((c) => (c.mean != null ? [c.mean] : []));
  const scores = students.flatMap((s) => (s.baseScore != null ? [s.baseScore] : []));
  const overallMean = meanScore(scores);
  const countDiff = counts.length ? Math.max(...counts) - Math.min(...counts) : 0;
  const meanDiff = means.length > 1 ? Math.max(...means) - Math.min(...means) : null;
  let genderGap: OverallStats["genderGap"] = null;
  for (const c of classes) {
    if (c.male + c.female === 0) continue;
    const value = Math.abs(c.male - c.female);
    if (!genderGap || value > genderGap.value) genderGap = { value, cls: c.cls, male: c.male, female: c.female };
  }
  return {
    classes,
    total: students.length,
    prevClasses: [...new Set(students.map((s) => s.prevClass))].sort((a, b) => a - b),
    countDiff,
    meanDiff,
    genderGap,
    overallMean,
    warnings: {
      count: countDiff >= THRESHOLDS.countDiff,
      // meanDiff / overallMean > meanDiffPercent / 100 를 정수 곱셈으로 비교
      mean: meanDiff != null && overallMean != null && meanDiff * 100 > overallMean * THRESHOLDS.meanDiffPercent,
      gender: genderGap != null && genderGap.value >= THRESHOLDS.genderGap,
    },
  };
}
