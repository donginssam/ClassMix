import { memo, useState, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { AlertTriangle, ArrowDownUp, MoreHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
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
import { formatScore, formatScoreDelta } from "@/lib/format";
import { cn } from "@/lib/utils";
import { sameValue } from "@/store/reuse";
import { actions } from "./actions";
import { useBoardUi, type ViewPrefs } from "./uiStore";

/**
 * 편성표: 세로축은 번호, 가로축은 반. 모든 칸의 높이가 같아서 반이 달라도 같은 번호끼리 줄이 맞는다.
 * 한 번호에 칸이 둘 이상인 반이 있으면 그 줄 전체가 그만큼 높아진다.
 */
export const ROW_H = 30;
export const AXIS_W = 44;
export const headerHeight = (pdf: boolean) => (pdf ? 88 : 72);

type CellViewPrefs = Pick<ViewPrefs, "showGender" | "showBirth" | "showScore" | "showPrev" | "showMemo">;

export function columnMinWidth(prefs: CellViewPrefs, pdf: boolean) {
  return (
    // 이름 칸(약 6글자)과 메뉴 단추. 메모는 남는 폭에만 보인다.
    132 + (prefs.showPrev ? 34 : 0) + (pdf && prefs.showScore ? 54 : 0) + (pdf && prefs.showBirth ? 54 : 0)
  );
}

export interface ClassSlot {
  kind: "student" | "gap";
  number: number;
  student?: Student;
  gap?: Gap;
}

export interface MatrixRow {
  number: number;
  /** 이 번호 줄의 칸 수(보통 1) */
  units: number;
}

/** 왼쪽 번호 축. 가로로 스크롤해도 붙어 있다. */
export function NumberAxis({ rows, pdf }: { rows: MatrixRow[]; pdf: boolean }) {
  return (
    <div
      className="sticky left-0 z-20 shrink-0 border-r border-(--glass-border) bg-muted/85 backdrop-blur-xl"
      style={{ width: AXIS_W }}
    >
      <div
        className="sticky top-0 z-30 flex items-end justify-center border-b border-(--glass-border) bg-muted pb-2 text-[11px] text-muted-foreground"
        style={{ height: headerHeight(pdf) }}
      >
        번호
      </div>
      {rows.map((r) => (
        <div
          key={r.number}
          className="flex items-start justify-center border-b text-xs text-muted-foreground tabular-nums"
          style={{ height: r.units * ROW_H, paddingTop: 7 }}
        >
          {r.number}
        </div>
      ))}
    </div>
  );
}

export interface ClassColumnProps {
  cls: number;
  classCount: number;
  rows: MatrixRow[];
  slotsByNumber: Map<number, ClassSlot[]>;
  stats: ClassStats;
  /** 학년 평균(기준성적) */
  overallMean: number | null;
  /** 편차 막대의 한쪽 끝이 뜻하는 점수 */
  devScale: number;
  minWidth: number;
  numbering: Numbering;
  violations: Violation[];
  /** 학생 → 위반 설명 */
  studentIssues: Map<number, string[]>;
  ruleKinds: Map<number, Set<RuleKind>>;
  showPdf: boolean;
  readOnly: boolean;
  nameOf: (id: number) => string;
}

export const ClassColumn = memo(function ClassColumn(props: ClassColumnProps) {
  const { cls, rows, slotsByNumber, stats, numbering, violations, showPdf: pdf, readOnly, nameOf } = props;
  const { setNodeRef, isOver } = useDroppable({ id: `c-${cls}`, data: { cls }, disabled: readOnly });
  const preview = useBoardUi((s) => s.previewViolation.has(cls));
  const prefs = useBoardUi(
    useShallow(({ prefs: { showGender, showBirth, showScore, showPrev, showMemo } }) => ({
      showGender,
      showBirth,
      showScore,
      showPrev,
      showMemo,
    })),
  );
  const lastNumber = Math.max(stats.lastNumber, ...[...slotsByNumber.keys()]);

  return (
    <section
      ref={setNodeRef}
      data-class={cls}
      className="flex-1 basis-0 border-r last:border-r-0"
      style={{ minWidth: props.minWidth }}
    >
      <header
        className={cn(
          // 헤더는 아래로 스크롤되는 칸을 가리되, 유리처럼 살짝 비친다.
          "sticky top-0 z-10 flex flex-col gap-1.5 border-b border-(--glass-border) px-2.5 pt-2 pb-2 backdrop-blur-xl transition-colors",
          violations.length > 0 && "shadow-[inset_0_3px_0_var(--destructive)]",
          preview ? "bg-violation-soft" : isOver ? "bg-accent" : "bg-background/85",
        )}
        style={{ height: headerHeight(pdf) }}
      >
        <div className="flex items-center gap-1.5">
          <h2 className="text-base font-semibold">{cls}반</h2>
          {violations.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-0.5 text-[11px] font-semibold text-destructive">
                  <AlertTriangle className="size-3" />
                  분리 {violations.length}
                </span>
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
          <span className="ml-auto flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "rounded-sm border px-1 text-[10.5px] leading-4 text-muted-foreground",
                    numbering === "sorted" ? "border-line-strong" : "border-dashed border-line-strong",
                  )}
                >
                  {numbering === "sorted" ? "가나다" : "나이스"}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {numbering === "sorted" ? "가나다순으로 다시 매긴 번호입니다." : "나이스에서 받은 번호 그대로입니다."}
              </TooltipContent>
            </Tooltip>
            {!readOnly && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`${cls}반 가나다순 재정렬`}
                    onClick={() => void actions.renumber([cls])}
                  >
                    <ArrowDownUp className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>이 반 가나다순 재정렬</TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
        <div className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-[11.5px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{stats.count}명</span>
          {pdf ? (
            <GenderBar male={stats.male} female={stats.female} />
          ) : (
            <span className="truncate">
              마지막 {stats.lastNumber}번{stats.gapCount > 0 && ` · 빈 번호 ${stats.gapCount}`}
            </span>
          )}
          {pdf && (
            <>
              <span className="font-medium text-foreground">{formatScore(stats.mean)}</span>
              <DeviationBar mean={stats.mean} overall={props.overallMean} scale={props.devScale} />
            </>
          )}
        </div>
      </header>

      {rows.map((r) => {
        const slots = slotsByNumber.get(r.number) ?? [];
        return (
          <div key={r.number} style={{ height: r.units * ROW_H }} className="flex flex-col">
            {slots.map((slot) =>
              slot.kind === "gap" ? (
                <GapCell key={`g${slot.gap!.id}`} gap={slot.gap!} readOnly={readOnly} />
              ) : (
                <StudentCell
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
            {slots.length < r.units && (
              <div className={cn("flex-1 border-b", r.number > lastNumber && "border-transparent bg-muted/40")} />
            )}
          </div>
        );
      })}
    </section>
  );
});

function GenderBar({ male, female }: { male: number; female: number }) {
  const total = male + female;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-hatch" aria-label={`남 ${male}명, 여 ${female}명`}>
          {total > 0 && (
            <>
              <div className="bg-boy" style={{ width: `${(male / total) * 100}%` }} />
              <div className="bg-girl" style={{ width: `${(female / total) * 100}%` }} />
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        남 {male} · 여 {female}
      </TooltipContent>
    </Tooltip>
  );
}

function DeviationBar({ mean, overall, scale }: { mean: number | null; overall: number | null; scale: number }) {
  if (mean == null || overall == null) return <div className="h-1.5 rounded-full bg-hatch" />;
  const dev = mean - overall;
  const w = Math.min(Math.abs(dev) / scale, 1) * 50;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative h-1.5" aria-label={`학년 평균 대비 ${formatScoreDelta(dev)}점`}>
          <div className="absolute inset-y-0 left-0 right-0 my-auto h-px bg-border" />
          <div className="absolute -inset-y-0.5 left-1/2 w-px bg-line-strong" />
          <div
            className="absolute inset-y-0 rounded-sm bg-primary"
            style={dev >= 0 ? { left: "50%", width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        학년 평균 {formatScore(overall)}점 대비 {formatScoreDelta(dev)}점
      </TooltipContent>
    </Tooltip>
  );
}

function GapCell({ gap, readOnly }: { gap: Gap; readOnly: boolean }) {
  const openDialog = useBoardUi((s) => s.openDialog);
  const [menu, setMenu] = useState(false);
  return (
    <div
      className="group bg-gap-stripes flex shrink-0 items-center gap-1 border-b px-2.5 text-xs text-muted-foreground"
      style={{ height: ROW_H }}
      onContextMenu={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setMenu(true);
      }}
    >
      <span className="min-w-0 flex-1 truncate">
        빈 번호
        {gap.plannedName ? ` · 전입 예정 ${gap.plannedName}` : gap.origin === "import" ? " · 나이스 결번" : ""}
      </span>
      {!readOnly && (
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label="빈 번호 메뉴"
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
    </div>
  );
}

const KIND_LABEL: Partial<Record<RuleKind, string>> = {
  twin: "쌍둥이",
  same_name: "동명이인",
  group: "분리 규칙",
  one_to_many: "분리 규칙",
};

type CellProps = {
  s: Student;
  prefs: CellViewPrefs;
  pdf: boolean;
  classCount: number;
  issues?: string[];
  kinds?: Set<RuleKind>;
  readOnly: boolean;
};

// 학생 칸은 보드에 수백 개가 있다. 끌기 훅(dnd-kit)이 있는 바깥 칸은 끄는 동안 대상이 바뀔 때마다 모두 다시 그려지므로
// 가볍게 두고, 내용은 따로 memo한다(가져온 학생 객체는 내용이 같으면 참조가 유지됨).
const StudentCell = memo(function StudentCell({ s, issues, readOnly, ...rest }: CellProps) {
  const selected = useBoardUi((u) => u.selected.includes(s.id));
  const highlighted = useBoardUi((u) => u.highlight.has(s.id));
  const toggleSelect = useBoardUi((u) => u.toggleSelect);
  const [menu, setMenu] = useState(false);

  const drag = useDraggable({ id: `s-${s.id}`, data: { studentId: s.id, cls: s.curClass }, disabled: readOnly });
  const drop = useDroppable({ id: `s-${s.id}`, data: { studentId: s.id, cls: s.curClass }, disabled: readOnly });
  const setRef = (el: HTMLDivElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };
  const moved = s.curClass !== s.origClass;

  return (
    <div
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
      style={{ height: ROW_H }}
      className={cn(
        "group flex shrink-0 cursor-pointer items-center gap-1.5 border-b pr-1 pl-2.5 tabular-nums outline-none select-none hover:bg-muted",
        moved && "bg-moved-soft hover:bg-moved-soft",
        issues && "bg-violation-soft text-destructive hover:bg-violation-soft",
        drop.isOver && !drag.isDragging && "bg-accent ring-1 ring-primary ring-inset",
        selected && "bg-accent font-medium ring-2 ring-primary ring-inset",
        highlighted && !selected && "ring-2 ring-found ring-inset",
        drag.isDragging && "opacity-40",
      )}
    >
      <StudentCellBody s={s} issues={issues} readOnly={readOnly} {...rest} menu={menu} setMenu={setMenu} />
    </div>
  );
});

type CellBodyProps = CellProps & { menu: boolean; setMenu: (open: boolean) => void };

const StudentCellBody = memo(function StudentCellBody({
  s,
  prefs,
  pdf,
  classCount,
  issues,
  kinds,
  readOnly,
  menu,
  setMenu,
}: CellBodyProps) {
  const roman = hasRomanLetters(s.name);
  const reading = cleanReading(s.sortName);
  const moved = s.curClass !== s.origClass;
  const kindLabels = [...new Set([...(kinds ?? [])].map((k) => KIND_LABEL[k]!))];
  // 위반 중이면 '분리' 표시 하나로 충분하다.
  const chips = issues ? kindLabels.filter((l) => l !== "분리 규칙") : kindLabels;

  return (
    <>
      {pdf && prefs.showGender && (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            s.gender === "남" ? "bg-boy" : s.gender === "여" ? "bg-girl" : "bg-line-strong",
          )}
          aria-label={s.gender ?? "성별 없음"}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("min-w-0 truncate text-sm", issues && "font-semibold", roman && "text-[13px]")}>
            {s.nameNorm}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">
          <StudentTooltipDetails student={s} kindLabels={kindLabels} issues={issues} />
        </TooltipContent>
      </Tooltip>
      {roman &&
        (reading ? (
          <span className="shrink-0 truncate text-[11px] text-muted-foreground">{reading}</span>
        ) : (
          <Chip className="border-moved text-moved">한글 미입력</Chip>
        ))}
      {issues && <Chip className="border-destructive text-destructive">분리</Chip>}
      {moved && <Chip className="border-transparent font-semibold text-moved">{s.origClass}반에서</Chip>}
      {chips.map((l) => (
        <Chip key={l} className="border-line-strong text-muted-foreground">
          {l}
        </Chip>
      ))}
      {prefs.showMemo && s.memo && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{s.memo}</span>}

      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 text-[11px] font-normal text-muted-foreground">
        {prefs.showPrev && <span>{s.prevClass}반</span>}
        {pdf && prefs.showBirth && <span>{s.birthDate?.slice(2) ?? "–"}</span>}
        {pdf && prefs.showScore && (
          <span className="w-14 text-right text-foreground/80">{formatScore(s.baseScore)}</span>
        )}
      </span>

      <span className="shrink-0" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={`${s.nameNorm} 메뉴`}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuLabel>
              {s.curClass}반 {s.curNumber}번 {s.nameNorm}
            </DropdownMenuLabel>
            {!readOnly && <StudentMenuItems student={s} classCount={classCount} roman={roman} hasReading={!!reading} />}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </>
  );
}, sameCellBodyProps);

// 보드를 갱신할 때 위반 문구가 그대로인 학생은 본문을 다시 그릴 필요가 없다.
function sameCellBodyProps(prev: CellBodyProps, next: CellBodyProps) {
  return (
    prev.s === next.s &&
    prev.prefs === next.prefs &&
    prev.pdf === next.pdf &&
    prev.classCount === next.classCount &&
    prev.kinds === next.kinds &&
    prev.readOnly === next.readOnly &&
    prev.menu === next.menu &&
    prev.setMenu === next.setMenu &&
    sameValue(prev.issues, next.issues)
  );
}

// Radix 포털이 열릴 때만 상세 내용과 메뉴 항목을 렌더링한다.
function StudentTooltipDetails({
  student: s,
  kindLabels,
  issues,
}: {
  student: Student;
  kindLabels: string[];
  issues?: string[];
}) {
  return (
    <div className="grid gap-0.5">
      <div>
        나이스 기본 편성: {s.origClass}반 {s.origNumber}번{s.curClass !== s.origClass && " → 반이 바뀜"}
      </div>
      {kindLabels.length > 0 && <div>{kindLabels.join(", ")} 대상</div>}
      {issues?.map((t) => (
        <div key={t} className="font-medium">
          분리 위반: {t}
        </div>
      ))}
      {s.memo && <div>메모: {s.memo}</div>}
    </div>
  );
}

function StudentMenuItems({
  student: s,
  classCount,
  roman,
  hasReading,
}: {
  student: Student;
  classCount: number;
  roman: boolean;
  hasReading: boolean;
}) {
  const openDialog = useBoardUi((u) => u.openDialog);
  return (
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
          한글 표기 {hasReading ? "수정" : "입력"}…
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
  );
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("shrink-0 rounded-sm border px-1 text-[10.5px] leading-4 font-medium", className)}>
      {children}
    </span>
  );
}
