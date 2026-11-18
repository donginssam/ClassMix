import { memo, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { AlertTriangle, ArrowDownUp, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hasRomanLetters } from "@/domain/normalize";
import { cleanReading } from "@/domain/numbering";
import type { Violation } from "@/domain/separation";
import type { ClassStats } from "@/domain/stats";
import type { Gap, Numbering, RuleKind, Student } from "@/lib/api";
import { cn } from "@/lib/utils";
import { actions } from "./actions";
import { useBoardUi, type ViewPrefs } from "./uiStore";

export interface ClassSlot {
  kind: "student" | "gap";
  number: number;
  student?: Student;
  gap?: Gap;
}

export interface ClassCardProps {
  cls: number;
  classCount: number;
  slots: ClassSlot[];
  stats: ClassStats;
  numbering: Numbering;
  violations: Violation[];
  /** 학생 → 위반 설명 */
  studentIssues: Map<number, string[]>;
  ruleKinds: Map<number, Set<RuleKind>>;
  showPdf: boolean;
  readOnly: boolean;
  nameOf: (id: number) => string;
}

export const ClassCard = memo(function ClassCard(props: ClassCardProps) {
  const { cls, slots, stats, numbering, violations, showPdf, readOnly, nameOf } = props;
  const { setNodeRef, isOver } = useDroppable({ id: `c-${cls}`, data: { cls }, disabled: readOnly });
  const preview = useBoardUi((s) => s.previewViolation.has(cls));
  const prefs = useBoardUi((s) => s.prefs);
  const pdf = showPdf;
  const colCount =
    2 +
    (prefs.showPrev ? 1 : 0) +
    (pdf && prefs.showGender ? 1 : 0) +
    (pdf && prefs.showBirth ? 1 : 0) +
    (pdf && prefs.showScore ? 1 : 0);

  return (
    <section
      ref={setNodeRef}
      data-class={cls}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-background shadow-xs transition-shadow",
        violations.length > 0 && "border-red-300 dark:border-red-900",
        isOver && "ring-2 ring-primary/60",
        preview && "ring-2 ring-red-500",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-2">
        <h2 className="text-base font-semibold">{cls}반</h2>
        <span className="text-sm tabular-nums">{stats.count}명</span>
        {pdf && (
          <span className="text-xs tabular-nums text-muted-foreground">
            남 {stats.male} · 여 {stats.female}
          </span>
        )}
        {stats.gapCount > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            마지막 {stats.lastNumber} · 빈 번호 {stats.gapCount}
          </span>
        )}
        {violations.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="destructive" className="h-5 gap-1 px-1.5">
                <AlertTriangle className="size-3" />
                분리 {violations.length}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              <ul className="space-y-0.5">
                {violations.map((v, i) => (
                  <li key={i}>
                    {v.studentIds.map(nameOf).join(", ")}
                    {v.rule.reason && ` (${v.rule.reason})`}
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {stats.mean != null && prefs.showScore && (
            <span className="text-xs tabular-nums text-muted-foreground">평균 {stats.mean.toFixed(2)}</span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={numbering === "sorted" ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px]">
                {numbering === "sorted" ? "가나다" : "나이스"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {numbering === "sorted" ? "가나다순으로 다시 매긴 번호입니다." : "나이스에서 받은 번호 그대로입니다."}
            </TooltipContent>
          </Tooltip>
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6" onClick={() => void actions.renumber([cls])}>
                  <ArrowDownUp className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>이 반 가나다순 재정렬</TooltipContent>
            </Tooltip>
          )}
        </span>
      </header>
      <table className="w-full table-fixed text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-10 py-1 pl-2 text-right font-normal">번호</th>
            <th className="py-1 pl-3 text-left font-normal">성명</th>
            {prefs.showPrev && <th className="w-12 py-1 text-center font-normal">이전</th>}
            {pdf && prefs.showGender && <th className="w-8 py-1 text-center font-normal">성별</th>}
            {pdf && prefs.showBirth && <th className="w-20 py-1 text-center font-normal">생년월일</th>}
            {pdf && prefs.showScore && <th className="w-16 py-1 pr-1 text-right font-normal">기준성적</th>}
            <th className="w-7" />
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) =>
            slot.kind === "gap" ? (
              <GapRow key={`g${slot.gap!.id}`} gap={slot.gap!} colSpan={colCount - 1} readOnly={readOnly} />
            ) : (
              <StudentRow
                key={slot.student!.id}
                s={slot.student!}
                prefs={prefs}
                pdf={pdf}
                classCount={props.classCount}
                issues={props.studentIssues.get(slot.student!.id)}
                kinds={props.ruleKinds.get(slot.student!.id)}
                readOnly={readOnly}
              />
            ),
          )}
          {slots.length === 0 && (
            <tr>
              <td colSpan={colCount + 1} className="py-6 text-center text-sm text-muted-foreground">
                학생이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
});

function GapRow({ gap, colSpan, readOnly }: { gap: Gap; colSpan: number; readOnly: boolean }) {
  const openDialog = useBoardUi((s) => s.openDialog);
  const [menu, setMenu] = useState(false);
  return (
    <tr
      className="group border-b border-dashed bg-muted/30 text-muted-foreground last:border-0"
      onContextMenu={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setMenu(true);
      }}
    >
      <td className="py-1 pl-2 text-right tabular-nums">{gap.number}</td>
      <td className="truncate py-1 pl-3 italic" colSpan={colSpan}>
        (빈 번호){gap.plannedName && ` 전입 예정: ${gap.plannedName}`}
        {gap.origin === "import" && !gap.plannedName && (
          <span className="ml-1 text-[11px] not-italic">· 나이스 결번</span>
        )}
      </td>
      <td className="py-0.5 pr-1 text-right">
        {!readOnly && (
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {gap.class}반 {gap.number}번 빈 번호
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => openDialog({ kind: "gapName", gapId: gap.id })}>
                전입 예정 이름 {gap.plannedName ? "수정" : "입력"}…
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void actions.removeGap(gap.id)}>
                빈 번호 지우기(뒤 번호 당기기)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  );
}

const KIND_ICON: Partial<Record<RuleKind, { icon: string; label: string }>> = {
  twin: { icon: "👥", label: "쌍둥이" },
  same_name: { icon: "🔤", label: "동명이인" },
  group: { icon: "🚨", label: "분리 학생" },
  one_to_many: { icon: "🚨", label: "분리 학생" },
};

function StudentRow({
  s,
  prefs,
  pdf,
  classCount,
  issues,
  kinds,
  readOnly,
}: {
  s: Student;
  prefs: ViewPrefs;
  pdf: boolean;
  classCount: number;
  issues?: string[];
  kinds?: Set<RuleKind>;
  readOnly: boolean;
}) {
  const selected = useBoardUi((u) => u.selected.includes(s.id));
  const highlighted = useBoardUi((u) => u.highlight.has(s.id));
  const toggleSelect = useBoardUi((u) => u.toggleSelect);
  const openDialog = useBoardUi((u) => u.openDialog);
  const [menu, setMenu] = useState(false);

  const drag = useDraggable({ id: `s-${s.id}`, data: { studentId: s.id, cls: s.curClass }, disabled: readOnly });
  const drop = useDroppable({ id: `s-${s.id}`, data: { studentId: s.id, cls: s.curClass }, disabled: readOnly });
  const setRef = (el: HTMLTableRowElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };

  const roman = hasRomanLetters(s.name);
  const reading = cleanReading(s.sortName);
  const moved = s.curClass !== s.origClass;
  const icons = [...new Set([...(kinds ?? [])].map((k) => KIND_ICON[k]!.icon))];
  const kindLabels = [...new Set([...(kinds ?? [])].map((k) => KIND_ICON[k]!.label))];

  return (
    <tr
      ref={setRef}
      data-student-id={s.id}
      {...drag.attributes}
      {...drag.listeners}
      tabIndex={-1}
      onClick={() => toggleSelect(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
      className={cn(
        "group cursor-pointer border-b outline-none select-none last:border-0 hover:bg-muted/60",
        moved && "bg-amber-50 dark:bg-amber-950/30",
        issues && "bg-red-50 dark:bg-red-950/30",
        drop.isOver && !drag.isDragging && "bg-primary/10 ring-1 ring-primary ring-inset",
        selected && "bg-primary/15 ring-2 ring-primary ring-inset",
        highlighted && !selected && "ring-2 ring-yellow-400 ring-inset",
        drag.isDragging && "opacity-40",
      )}
    >
      <td className="py-1 pl-2 text-right tabular-nums">
        <button
          type="button"
          disabled={readOnly}
          className="rounded px-1 text-muted-foreground hover:bg-background hover:text-foreground hover:underline disabled:hover:no-underline"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openDialog({ kind: "number", studentId: s.id });
          }}
          title="번호 직접 수정"
        >
          {s.curNumber}
        </button>
      </td>
      <td className="py-1 pl-3">
        <div className="flex min-w-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("truncate", roman && "text-[13px]")}>{s.nameNorm}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              <div>
                학번 {s.studentNo} · 이전 {s.prevClass}반 {s.prevNumber}번
              </div>
              <div>
                나이스 기본 편성: {s.origClass}반 {s.origNumber}번{moved && " → 반이 바뀜"}
              </div>
              {kindLabels.length > 0 && <div>{kindLabels.join(", ")} 규칙 대상</div>}
              {issues?.map((t) => (
                <div key={t} className="font-medium">
                  ⚠️ {t}
                </div>
              ))}
              {s.memo && <div>메모: {s.memo}</div>}
            </TooltipContent>
          </Tooltip>
          {s.sameName && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              (이전 {s.prevClass}-{s.prevNumber})
            </span>
          )}
          {roman &&
            (reading ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">({reading})</span>
            ) : (
              <Badge variant="outline" className="h-4 shrink-0 border-amber-400 px-1 text-[10px] text-amber-700">
                발음 미입력
              </Badge>
            ))}
          {icons.length > 0 && <span className="shrink-0 text-xs">{icons.join("")}</span>}
          {prefs.showMemo && s.memo && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">· {s.memo}</span>
          )}
        </div>
      </td>
      {prefs.showPrev && (
        <td className="py-1 text-center tabular-nums text-muted-foreground">
          {s.prevClass}-{s.prevNumber}
        </td>
      )}
      {pdf && prefs.showGender && (
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
      {pdf && prefs.showBirth && (
        <td className="py-1 text-center text-xs tabular-nums text-muted-foreground">{s.birthDate?.slice(2) ?? "–"}</td>
      )}
      {pdf && prefs.showScore && (
        <td className="py-1 pr-1 text-right tabular-nums">{s.baseScore?.toFixed(2) ?? "–"}</td>
      )}
      <td
        className="py-0.5 pr-1 text-right"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuLabel>
              {s.curClass}반 {s.curNumber}번 {s.nameNorm}
            </DropdownMenuLabel>
            {!readOnly && (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>다른 반으로 이동</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {Array.from({ length: classCount }, (_, i) => i + 1).map((c) => (
                      <DropdownMenuItem key={c} disabled={c === s.curClass} onSelect={() => void actions.move(s.id, c)}>
                        {c}반{c === s.origClass && " (원래 반)"}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openDialog({ kind: "number", studentId: s.id })}>
                  번호 직접 수정…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void actions.addGapBefore(s.id)}>앞에 빈 번호 넣기</DropdownMenuItem>
                {roman && (
                  <DropdownMenuItem onSelect={() => openDialog({ kind: "reading", studentIds: [s.id] })}>
                    한글 발음 {reading ? "수정" : "입력"}…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => openDialog({ kind: "memo", studentId: s.id })}>
                  메모 {s.memo ? "수정" : "입력"}…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openDialog({ kind: "separation", tab: "group", preselect: [s.id] })}>
                  분리 학생 규칙 만들기…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}
