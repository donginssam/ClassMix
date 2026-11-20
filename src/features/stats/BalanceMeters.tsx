import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { THRESHOLDS, type OverallStats } from "@/domain/stats";
import { formatScore, roundDiv } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 막대 끝이 기준의 1.5배가 되도록 그린다. 기준 눈금은 2/3 지점. */
const SPAN = 1.5;

interface Meter {
  label: string;
  value: string;
  limit: string;
  ratio: number | null;
  warn: boolean;
  /** 안내 줄: 첫 줄은 설명, 나머지는 숫자 하나씩 */
  help: string[];
}

/** 반 사이 균형 요약: 인원 차·평균 성적 차·성비 차를 경고 기준 눈금과 함께 늘 보여 준다. */
export function BalanceMeters({ stats, showPdf }: { stats: OverallStats; showPdf: boolean }) {
  // 경고 기준(학년 평균의 n%), 100배 정수
  const meanLimit = stats.overallMean != null ? roundDiv(stats.overallMean * THRESHOLDS.meanDiffPercent, 100) : null;
  const meters: Meter[] = [
    {
      label: "반 간 인원 차",
      value: `${stats.countDiff}명`,
      limit: `${THRESHOLDS.countDiff}명부터 경고`,
      ratio: stats.countDiff / THRESHOLDS.countDiff,
      warn: stats.warnings.count,
      help: ["인원이 가장 많은 반과 가장 적은 반의 차이입니다.", `경고 기준: ${THRESHOLDS.countDiff}명 이상`],
    },
  ];
  if (showPdf) {
    meters.push(
      {
        label: "반 평균 성적 차",
        value: stats.meanDiff == null ? "–" : `${formatScore(stats.meanDiff)}점`,
        limit: meanLimit == null ? "" : `기준 ${formatScore(meanLimit)}점`,
        ratio: stats.meanDiff != null && meanLimit ? stats.meanDiff / meanLimit : null,
        warn: stats.warnings.mean,
        help:
          stats.overallMean != null
            ? [
                "반 평균이 가장 높은 반과 낮은 반의 차이입니다.",
                `학년 평균: ${formatScore(stats.overallMean)}점`,
                `경고 기준: 학년 평균의 ${THRESHOLDS.meanDiffPercent}%${meanLimit != null ? `(${formatScore(meanLimit)}점)` : ""} 초과`,
              ]
            : ["기준성적이 있는 학생이 없습니다."],
      },
      {
        label: "성비 차",
        value: stats.genderGap == null ? "–" : `${stats.genderGap.value}명`,
        limit: `${THRESHOLDS.genderGap}명부터 경고`,
        ratio: stats.genderGap == null ? null : stats.genderGap.value / THRESHOLDS.genderGap,
        warn: stats.warnings.gender,
        help:
          stats.genderGap == null
            ? ["성별 자료가 없습니다."]
            : [
                "반마다 남녀 학생 수 차이 중 가장 큰 값입니다.",
                `가장 큰 반: ${stats.genderGap.cls}반 (남 ${stats.genderGap.male} · 여 ${stats.genderGap.female})`,
                `경고 기준: ${THRESHOLDS.genderGap}명 이상`,
              ],
      },
    );
  }

  return (
    <div className="flex flex-wrap items-stretch gap-3 px-4 pt-3 pb-3 select-none">
      <div className="grid min-w-0 flex-1 grid-cols-1 divide-y rounded-md border bg-background sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {meters.map((m) => (
          <MeterView key={m.label} m={m} />
        ))}
        {!showPdf && (
          <p className="col-span-2 flex items-center px-4 py-2 text-xs text-muted-foreground">
            반편성내역 PDF를 가져오면 평균 성적 차와 성비 차도 여기서 볼 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
}

function MeterView({ m }: { m: Meter }) {
  const fill = m.ratio == null ? 0 : Math.min(m.ratio / SPAN, 1) * 100;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="grid gap-1.5 px-4 py-2.5" tabIndex={0}>
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("flex items-center gap-1 text-xs text-muted-foreground", m.warn && "text-destructive")}>
              {m.warn && <AlertTriangle className="size-3.5" />}
              {m.label}
            </span>
            <span className="tabular-nums">
              <span className={cn("text-lg font-semibold", m.warn && "text-destructive")}>{m.value}</span>
              {m.limit && <span className="ml-1.5 text-xs text-muted-foreground">{m.limit}</span>}
            </span>
          </div>
          <div className="relative h-1.5 rounded-full bg-hatch">
            <div
              className={cn("absolute inset-y-0 left-0 rounded-full", m.warn ? "bg-destructive" : "bg-ok")}
              style={{ width: `${fill}%` }}
            />
            <div
              className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground"
              style={{ left: `calc(${100 / SPAN}% - 1px)` }}
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <div className="grid gap-0.5">
          {m.help.map((line, i) => (
            <p key={line} className={cn(i === 0 && "mb-1")}>
              {line}
            </p>
          ))}
          <p className="mt-1 font-medium">{m.warn ? "지금은 경고 기준을 넘었습니다." : "지금은 경고 기준 안입니다."}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
