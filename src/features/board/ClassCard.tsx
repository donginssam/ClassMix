import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hasRomanLetters } from "@/domain/normalize";
import { cn } from "@/lib/utils";
import type { ClassSlot } from "./BoardScreen";

export function ClassCard({ cls, slots, showPdf }: { cls: number; slots: ClassSlot[]; showPdf: boolean }) {
  const students = slots.flatMap((s) => (s.student ? [s.student] : []));
  const male = students.filter((s) => s.gender === "남").length;
  const female = students.filter((s) => s.gender === "여").length;
  const scores = students.flatMap((s) => (s.baseScore != null ? [s.baseScore] : []));
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const gapCount = slots.length - students.length;

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border bg-background shadow-xs">
      <header className="flex items-baseline gap-2 border-b px-3 py-2">
        <h2 className="text-base font-semibold">{cls}반</h2>
        <span className="text-sm tabular-nums text-muted-foreground">{students.length}명</span>
        {showPdf && (
          <span className="text-xs tabular-nums text-muted-foreground">
            남 {male} · 여 {female}
          </span>
        )}
        {gapCount > 0 && <span className="text-xs tabular-nums text-muted-foreground">빈 번호 {gapCount}</span>}
        {avg != null && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">평균 {avg.toFixed(2)}</span>
        )}
      </header>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-10 py-1 pl-3 text-right font-normal">번호</th>
            <th className="py-1 pl-3 text-left font-normal">성명</th>
            <th className="w-14 py-1 text-center font-normal">이전</th>
            {showPdf && <th className="w-8 py-1 text-center font-normal">성별</th>}
            {showPdf && <th className="w-16 py-1 pr-3 text-right font-normal">기준성적</th>}
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) =>
            slot.kind === "gap" ? (
              <tr key={`g${slot.gap!.id}`} className="border-b border-dashed text-muted-foreground last:border-0">
                <td className="py-1 pl-3 text-right tabular-nums">{slot.number}</td>
                <td className="py-1 pl-3 italic" colSpan={showPdf ? 4 : 2}>
                  빈 번호{slot.gap!.plannedName && ` · 전입 예정 ${slot.gap!.plannedName}`}
                </td>
              </tr>
            ) : (
              <StudentRow key={slot.student!.id} slot={slot} showPdf={showPdf} />
            ),
          )}
        </tbody>
      </table>
    </section>
  );
}

function StudentRow({ slot, showPdf }: { slot: ClassSlot; showPdf: boolean }) {
  const s = slot.student!;
  const roman = hasRomanLetters(s.name);
  return (
    <tr className="border-b last:border-0 hover:bg-muted/50">
      <td className="py-1 pl-3 text-right tabular-nums text-muted-foreground">{s.curNumber}</td>
      <td className="py-1 pl-3">
        <span className="flex items-center gap-1.5">
          <span className={cn("truncate", roman && "text-[13px]")}>{s.nameNorm}</span>
          {s.sameName && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  동명
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                동명이인 — 학번 {s.studentNo}, 이전 {s.prevClass}-{s.prevNumber}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </td>
      <td className="py-1 text-center tabular-nums text-muted-foreground">
        {s.prevClass}-{s.prevNumber}
      </td>
      {showPdf && (
        <td
          className={cn(
            "py-1 text-center",
            s.gender === "남" && "text-sky-700 dark:text-sky-400",
            s.gender === "여" && "text-rose-700 dark:text-rose-400",
          )}
        >
          {s.gender ?? "–"}
        </td>
      )}
      {showPdf && <td className="py-1 pr-3 text-right tabular-nums">{s.baseScore?.toFixed(2) ?? "–"}</td>}
    </tr>
  );
}
