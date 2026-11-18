/** 반별·전체 통계(§8.2). */
import type { Gap, Student } from "@/lib/api";

export interface ClassStats {
  cls: number;
  count: number;
  male: number;
  female: number;
  /** 이전 n반 → 인원 */
  prevDist: Map<number, number>;
  scoreCount: number;
  mean: number | null;
  std: number | null;
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
  meanDiff: number | null;
  /** 남학생 비율 최대-최소(0~1) */
  maleRatioDiff: number | null;
  overallMean: number | null;
  warnings: { count: boolean; mean: boolean; gender: boolean };
}

/** 경고 기준 */
export const THRESHOLDS = {
  /** 반 간 인원 차 */
  countDiff: 2,
  /** 반 평균 성적 차(전체 평균 대비 비율) */
  meanDiffRatio: 0.02,
  /** 남학생 비율 차 */
  maleRatioDiff: 0.1,
};

export function classStats(cls: number, students: Student[], gaps: Gap[]): ClassStats {
  const members = students.filter((s) => s.curClass === cls);
  const prevDist = new Map<number, number>();
  for (const s of members) prevDist.set(s.prevClass, (prevDist.get(s.prevClass) ?? 0) + 1);
  const scored = members.filter((s) => s.baseScore != null);
  const scores = scored.map((s) => s.baseScore!);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const std =
    mean != null && scores.length ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) : null;
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
    std,
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
  const ratios = classes.flatMap((c) => (c.male + c.female > 0 ? [c.male / (c.male + c.female)] : []));
  const scores = students.flatMap((s) => (s.baseScore != null ? [s.baseScore] : []));
  const overallMean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const countDiff = counts.length ? Math.max(...counts) - Math.min(...counts) : 0;
  const meanDiff = means.length > 1 ? Math.max(...means) - Math.min(...means) : null;
  const maleRatioDiff = ratios.length > 1 ? Math.max(...ratios) - Math.min(...ratios) : null;
  return {
    classes,
    total: students.length,
    prevClasses: [...new Set(students.map((s) => s.prevClass))].sort((a, b) => a - b),
    countDiff,
    meanDiff,
    maleRatioDiff,
    overallMean,
    warnings: {
      count: countDiff >= THRESHOLDS.countDiff,
      mean: meanDiff != null && overallMean != null && meanDiff > overallMean * THRESHOLDS.meanDiffRatio,
      gender: maleRatioDiff != null && maleRatioDiff >= THRESHOLDS.maleRatioDiff,
    },
  };
}
