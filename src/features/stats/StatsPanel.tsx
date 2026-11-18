import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { OverallStats } from "@/domain/stats";
import { cn } from "@/lib/utils";

/** 반별 통계표 + 전체 편차 요약(§8.2). PDF가 없으면 성별·성적 열을 숨긴다. */
export function StatsPanel({ stats, showPdf }: { stats: OverallStats; showPdf: boolean }) {
  const maxPrev = Math.max(1, ...stats.classes.flatMap((c) => [...c.prevDist.values()]));
  const f2 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));

  return (
    <div className="border-b bg-background px-5 py-3 select-none">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <Summary warn={stats.warnings.count} label="반 간 인원 차" value={`${stats.countDiff}명`} />
        {showPdf && (
          <>
            <Summary
              warn={stats.warnings.mean}
              label="반 평균 성적 차"
              value={stats.meanDiff == null ? "–" : stats.meanDiff.toFixed(2)}
              sub={stats.overallMean != null ? `전체 평균 ${stats.overallMean.toFixed(2)}` : undefined}
            />
            <Summary
              warn={stats.warnings.gender}
              label="남학생 비율 차"
              value={stats.maleRatioDiff == null ? "–" : `${(stats.maleRatioDiff * 100).toFixed(1)}%p`}
            />
          </>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-1 pr-3 text-left font-normal">반</th>
              <th className="px-2 py-1 text-right font-normal">인원</th>
              {showPdf && <th className="px-2 py-1 text-right font-normal">남</th>}
              {showPdf && <th className="px-2 py-1 text-right font-normal">여</th>}
              {showPdf && <th className="px-2 py-1 text-right font-normal">평균</th>}
              {showPdf && <th className="px-2 py-1 text-right font-normal">표준편차</th>}
              {showPdf && <th className="px-2 py-1 text-left font-normal">최고</th>}
              {showPdf && <th className="px-2 py-1 text-left font-normal">최저</th>}
              <th className="px-2 py-1 text-right font-normal">마지막 번호</th>
              <th className="px-2 py-1 text-right font-normal">빈 번호</th>
              <th className="px-2 py-1 text-right font-normal">옮겨 온</th>
              {stats.prevClasses.map((p) => (
                <th key={p} className="w-9 px-1 py-1 text-center font-normal">
                  이전{p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.classes.map((c) => (
              <tr key={c.cls} className="border-b last:border-0">
                <td className="py-1 pr-3 font-medium">{c.cls}반</td>
                <td className="px-2 py-1 text-right">{c.count}</td>
                {showPdf && <td className="px-2 py-1 text-right text-sky-700 dark:text-sky-400">{c.male}</td>}
                {showPdf && <td className="px-2 py-1 text-right text-rose-700 dark:text-rose-400">{c.female}</td>}
                {showPdf && <td className="px-2 py-1 text-right">{f2(c.mean)}</td>}
                {showPdf && <td className="px-2 py-1 text-right">{f2(c.std)}</td>}
                {showPdf && (
                  <td className="px-2 py-1">
                    {c.max ? (
                      <>
                        {c.max.score.toFixed(2)} <span className="text-muted-foreground">{c.max.name}</span>
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                )}
                {showPdf && (
                  <td className="px-2 py-1">
                    {c.min ? (
                      <>
                        {c.min.score.toFixed(2)} <span className="text-muted-foreground">{c.min.name}</span>
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                )}
                <td className="px-2 py-1 text-right">{c.lastNumber}</td>
                <td className="px-2 py-1 text-right">{c.gapCount || ""}</td>
                <td className="px-2 py-1 text-right">{c.movedIn || ""}</td>
                {stats.prevClasses.map((p) => {
                  const n = c.prevDist.get(p) ?? 0;
                  return (
                    <td key={p} className="px-0.5 py-0.5 text-center">
                      <span
                        className="block rounded px-1 py-0.5"
                        style={{
                          backgroundColor: n
                            ? `color-mix(in oklch, var(--chart-2) ${Math.round((n / maxPrev) * 70)}%, transparent)`
                            : undefined,
                        }}
                      >
                        {n || ""}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("flex items-center gap-1", warn && "font-medium text-amber-700 dark:text-amber-400")}>
          {warn && <AlertTriangle className="size-3.5" />}
          {label} <span className="tabular-nums">{value}</span>
          {sub && <span className="text-xs text-muted-foreground">({sub})</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>{warn ? "허용치를 넘었습니다." : "허용치 안입니다."}</TooltipContent>
    </Tooltip>
  );
}
