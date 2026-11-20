import type { OverallStats } from "@/domain/stats";
import { formatScore } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 반별 통계표(§8.2). 전체 편차 요약은 BalanceMeters가 맡는다. PDF가 없으면 성별·성적 열을 숨긴다. */
export function StatsPanel({ stats, showPdf }: { stats: OverallStats; showPdf: boolean }) {
  const maxPrev = Math.max(1, ...stats.classes.flatMap((c) => [...c.prevDist.values()]));
  const f2 = (v: number | null | undefined) => formatScore(v);

  return (
    <div className="mx-4 mb-3 rounded-md border bg-background px-4 py-2 select-none">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-1 pr-3 text-left font-normal">반</th>
              <th className="px-2 py-1 text-right font-normal">인원</th>
              {showPdf && <th className="px-2 py-1 text-right font-normal">남</th>}
              {showPdf && <th className="px-2 py-1 text-right font-normal">여</th>}
              {showPdf && <th className="px-2 py-1 text-right font-normal">평균</th>}
              {showPdf && <th className="py-1 pr-2 pl-6 text-left font-normal">최고</th>}
              {showPdf && <th className="py-1 pr-2 pl-6 text-left font-normal">최저</th>}
              <th className="px-2 py-1 text-right font-normal">마지막 번호</th>
              <th className="px-2 py-1 text-right font-normal">빈 번호</th>
              <th className="px-2 py-1 text-right font-normal">옮겨 온</th>
              {stats.prevClasses.map((p) => (
                <th key={p} className="px-1 py-1 text-center font-normal whitespace-nowrap">
                  이전 {p}반
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.classes.map((c) => (
              <tr key={c.cls} className="border-b last:border-0">
                <td className="py-1 pr-3 font-medium">{c.cls}반</td>
                <td className="px-2 py-1 text-right">{c.count}</td>
                {showPdf && <td className="px-2 py-1 text-right text-boy">{c.male}</td>}
                {showPdf && <td className="px-2 py-1 text-right text-girl">{c.female}</td>}
                {showPdf && <td className="px-2 py-1 text-right">{f2(c.mean)}</td>}
                {showPdf && (
                  <td className="py-1 pr-2 pl-6">
                    {c.max ? (
                      <>
                        {formatScore(c.max.score)} <span className="text-muted-foreground">{c.max.name}</span>
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                )}
                {showPdf && (
                  <td className="py-1 pr-2 pl-6">
                    {c.min ? (
                      <>
                        {formatScore(c.min.score)} <span className="text-muted-foreground">{c.min.name}</span>
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
                        className={cn("block rounded px-1 py-0.5", n === 0 && "text-muted-foreground")}
                        style={{
                          backgroundColor: n
                            ? `color-mix(in oklch, var(--chart-2) ${Math.round((n / maxPrev) * 70)}%, transparent)`
                            : undefined,
                        }}
                      >
                        {n}
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
