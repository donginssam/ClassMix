import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  ArrowDownUp,
  ArrowLeftRight,
  BarChart3,
  ChevronDown,
  Download,
  History,
  Redo2,
  Search,
  ShieldAlert,
  Undo2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { numberingOf } from "@/domain/changes";
import { hasRomanLetters, nameKey } from "@/domain/normalize";
import { cleanReading } from "@/domain/numbering";
import {
  allViolations,
  describeViolation,
  newViolationClasses,
  ruleKindsByStudent,
  violationsByClass,
  violationsByStudent,
} from "@/domain/separation";
import { overallStats, THRESHOLDS } from "@/domain/stats";
import { roundDiv } from "@/lib/format";
import {
  closeWorkFile,
  openWorkFileWithDialog,
  saveWorkFileAsWithDialog,
  saveWorkFileCopyWithDialog,
} from "@/lib/fileActions";
import { IS_MAC, isHelpKey, isTypingTarget, shortcut } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { dragRegion, TitleBar } from "@/app/TitleBar";
import { useWorkspace } from "@/store/workspace";
import { PdfImportDialog } from "@/features/import-pdf/PdfImportDialog";
import { SeparationDialog } from "@/features/constraints/SeparationDialog";
import { TwinReviewDialog, useTwinCandidates } from "@/features/constraints/TwinReviewDialog";
import { twinCandidates } from "@/domain/siblings";
import { ExportDialog } from "@/features/export/ExportDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { ShortcutsDialog } from "@/features/settings/ShortcutsDialog";
import { BalanceMeters } from "@/features/stats/BalanceMeters";
import { StatsPanel } from "@/features/stats/StatsPanel";
import { actions } from "./actions";
import { ClassColumn, columnMinWidth, NumberAxis, type ClassSlot, type MatrixRow } from "./ClassColumn";
import { BoardDialogs } from "./dialogs";
import { HistoryPanel } from "./HistoryPanel";
import { scrollToStudent, useBoardUi } from "./uiStore";

export type { ClassSlot };

/** 학생 행 위를 먼저, 없으면 반 카드를 놓을 곳으로 고른다. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const list = hits.length ? hits : rectIntersection(args);
  const student = list.find((c) => String(c.id).startsWith("s-"));
  return student ? [student] : list.filter((c) => String(c.id).startsWith("c-")).slice(0, 1);
};

function isTyping(e: KeyboardEvent) {
  return isTypingTarget(e.target);
}

export function BoardScreen() {
  const workspace = useWorkspace((s) => s.workspace)!;
  const students = useWorkspace((s) => s.students);
  const gaps = useWorkspace((s) => s.gaps);
  const classStates = useWorkspace((s) => s.classStates);
  const rules = useWorkspace((s) => s.rules);
  const canUndo = useWorkspace((s) => s.canUndo);
  const canRedo = useWorkspace((s) => s.canRedo);
  const undo = useWorkspace((s) => s.undo);
  const redo = useWorkspace((s) => s.redo);
  const pendingReadingPrompt = useWorkspace((s) => s.pendingReadingPrompt);
  const setPendingReadingPrompt = useWorkspace((s) => s.setPendingReadingPrompt);

  const prefs = useBoardUi((s) => s.prefs);
  const setPrefs = useBoardUi((s) => s.setPrefs);
  const selected = useBoardUi((s) => s.selected);
  const clearSelection = useBoardUi((s) => s.clearSelection);
  const dialog = useBoardUi((s) => s.dialog);
  const openDialog = useBoardUi((s) => s.openDialog);
  const closeDialog = useBoardUi((s) => s.closeDialog);
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const highlight = useBoardUi((s) => s.highlight);
  const setPreviewViolation = useBoardUi((s) => s.setPreviewViolation);

  const readOnly = workspace.readOnly;
  const classCount = workspace.classCount ?? 0;
  const hasPdf = workspace.pdfLinkedCount > 0;
  const twinCount = useTwinCandidates().length;

  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const nameOf = useCallback((id: number) => byId.get(id)?.nameNorm ?? `#${id}`, [byId]);
  const classOf = useCallback((id: number) => byId.get(id)?.curClass, [byId]);

  const stats = useMemo(() => overallStats(classCount, students, gaps), [classCount, students, gaps]);
  const violations = useMemo(() => allViolations(rules, classOf), [rules, classOf]);
  const vByClass = useMemo(() => violationsByClass(violations), [violations]);
  const studentIssues = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const [id, vs] of violationsByStudent(violations))
      m.set(
        id,
        vs.map((v) => describeViolation(v, nameOf)),
      );
    return m;
  }, [violations, nameOf]);
  const ruleKinds = useMemo(() => ruleKindsByStudent(rules), [rules]);
  const noReading = useMemo(
    () => students.filter((s) => hasRomanLetters(s.name) && !cleanReading(s.sortName)).length,
    [students],
  );

  // 편성표: 반마다 번호 → 칸 목록. 줄 높이는 그 번호에서 칸이 가장 많은 반에 맞춘다.
  const { classes, rows } = useMemo(() => {
    const classes = Array.from({ length: classCount }, (_, i) => ({
      cls: i + 1,
      slotsByNumber: new Map<number, ClassSlot[]>(),
    }));
    const put = (cls: number, slot: ClassSlot) => {
      const m = classes[cls - 1]?.slotsByNumber;
      if (!m) return;
      const list = m.get(slot.number);
      if (list) list.push(slot);
      else m.set(slot.number, [slot]);
    };
    for (const s of students) put(s.curClass, { kind: "student", number: s.curNumber, student: s });
    for (const g of gaps) put(g.class, { kind: "gap", number: g.number, gap: g });
    let max = 0;
    for (const c of classes)
      for (const [n, list] of c.slotsByNumber) {
        max = Math.max(max, n);
        list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "student" ? -1 : 1));
      }
    const rows: MatrixRow[] = Array.from({ length: max }, (_, i) => ({
      number: i + 1,
      units: Math.max(1, ...classes.map((c) => c.slotsByNumber.get(i + 1)?.length ?? 0)),
    }));
    return { classes, rows };
  }, [students, gaps, classCount]);
  // 편차 막대 끝 = 경고 기준(학년 평균의 n%)과 가장 큰 편차 중 큰 쪽(모두 100배 정수, 막대 길이 계산용)
  const devScale = useMemo(() => {
    const om = stats.overallMean;
    if (om == null) return 1;
    const devs = stats.classes.flatMap((c) => (c.mean != null ? [Math.abs(c.mean - om)] : []));
    return Math.max(roundDiv(om * THRESHOLDS.meanDiffPercent, 100), ...devs, 1);
  }, [stats]);
  const colMinWidth = columnMinWidth(prefs, hasPdf);

  // XLSX를 막 가져왔으면 로마자 이름 한글 발음 입력 단계를 띄운다(대상이 있을 때만).
  useEffect(() => {
    if (!pendingReadingPrompt) return;
    setPendingReadingPrompt(false);
    if (readOnly || !students.some((s) => hasRomanLetters(s.name))) return;
    // 가져오기 결과 창이 닫히며 포커스를 되돌리는 순간에 새 창을 열면 '바깥 포커스'로 곧바로 닫힌다.
    // 결과 창이 완전히 사라진 뒤 연다. (상태가 바뀌어 effect가 다시 돌아도 취소하지 않는다.)
    window.setTimeout(() => openDialog({ kind: "reading", studentIds: "all" }), 250);
  }, [pendingReadingPrompt, students, readOnly, openDialog, setPendingReadingPrompt]);

  // ───────── 검색 ─────────
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const k = nameKey(query);
    if (!k) return [];
    return students
      .filter((s) => nameKey(s.name).includes(k) || (s.sortName && nameKey(s.sortName).includes(k)))
      .sort((a, b) => a.curClass - b.curClass || a.curNumber - b.curNumber);
  }, [query, students]);
  // 검색어가 바뀌면 커서는 첫 결과로 돌아간다.
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const matchIdx = cursor.query === query ? cursor.index : 0;
  useEffect(() => {
    setHighlight(matches.map((s) => s.id));
    if (matches[0]) scrollToStudent(matches[0].id);
  }, [matches, setHighlight]);
  const nextMatch = () => {
    if (!matches.length) return;
    const i = (matchIdx + 1) % matches.length;
    setCursor({ query, index: i });
    scrollToStudent(matches[i].id);
  };

  // ───────── 단축키 ─────────
  // macOS: 메뉴의 [실행 취소/복귀](Cmd+Z, Cmd+Shift+Z)가 이벤트로 온다. 입력칸에서는 글자 되돌리기로 쓴다.
  useEffect(() => {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const handle = (kind: "undo" | "redo") => {
      if (isTypingTarget(document.activeElement)) {
        document.execCommand(kind);
        return;
      }
      if (useBoardUi.getState().dialog || readOnly) return;
      void (kind === "undo" ? undo() : redo());
    };
    import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const a = await listen("menu-undo", () => handle("undo"));
        const b = await listen("menu-redo", () => handle("redo"));
        if (disposed) {
          a();
          b();
        } else unlisten.push(a, b);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten.forEach((f) => f());
    };
  }, [readOnly, undo, redo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // 되돌리기 키: macOS는 메뉴가 처리하므로 Ctrl만 본다(Windows).
      const undoMod = IS_MAC ? false : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (dialog) return;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openWorkFileWithDialog();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveWorkFileAsWithDialog();
        return;
      }
      if (isHelpKey(e)) {
        e.preventDefault();
        openDialog({ kind: "shortcuts" });
        return;
      }
      if (isTyping(e)) return;
      if (undoMod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!readOnly) void undo();
      } else if (undoMod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        if (!readOnly) void redo();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        openDialog({ kind: "export" });
      } else if (e.key === "Escape") {
        clearSelection();
        setHighlight([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, readOnly, undo, redo, openDialog, clearSelection, setHighlight]);

  // ───────── 선택 ─────────
  const selStudents = selected.map((id) => byId.get(id)).filter((s) => s != null);
  const canSwap = selStudents.length === 2 && selStudents[0].curClass !== selStudents[1].curClass;

  // ───────── 드래그 ─────────
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragId, setDragId] = useState<number | null>(null);
  const targetOf = (e: DragOverEvent | DragEndEvent) => {
    const from = e.active.data.current as { studentId: number; cls: number } | undefined;
    const over = e.over?.data.current as { studentId?: number; cls: number } | undefined;
    if (!from || !over || over.cls === from.cls) return null;
    return over.studentId != null
      ? { kind: "swap" as const, a: from.studentId, b: over.studentId, fromCls: from.cls, toCls: over.cls }
      : { kind: "move" as const, a: from.studentId, fromCls: from.cls, toCls: over.cls };
  };
  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as { studentId: number } | undefined;
    setDragId(d?.studentId ?? null);
  };
  const onDragOver = (e: DragOverEvent) => {
    const t = targetOf(e);
    if (!t) {
      setPreviewViolation(new Set());
      return;
    }
    const overrides = new Map<number, number>([[t.a, t.toCls]]);
    if (t.kind === "swap") overrides.set(t.b, t.fromCls);
    setPreviewViolation(newViolationClasses(rules, classOf, overrides));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const t = targetOf(e);
    setDragId(null);
    setPreviewViolation(new Set());
    if (!t) return;
    clearSelection();
    if (t.kind === "swap") void actions.swap(t.a, t.b);
    else void actions.move(t.a, t.toCls);
  };
  const dragStudent = dragId != null ? byId.get(dragId) : null;

  return (
    <div className="flex h-full flex-col bg-board">
      <TitleBar className="z-20 gap-1.5">
        <div {...dragRegion} className="mr-2 min-w-0 flex-1">
          <div {...dragRegion} className="flex items-center gap-2">
            <h1 {...dragRegion} className="truncate text-sm leading-5 font-semibold">
              {workspace.fileName}
            </h1>
            {readOnly && <Badge variant="secondary">읽기 전용</Badge>}
          </div>
          <p {...dragRegion} className="truncate text-xs leading-4 text-muted-foreground">
            {workspace.targetGrade} · {classCount}개 반 · 학생 {workspace.studentCount}명
            {hasPdf ? ` · 기준성적 ${workspace.pdfLinkedCount}명` : " · 성적 없이 조정"}
          </p>
        </div>

        <GlassGroup>
          <ToolButton label={`되돌리기 (${shortcut("Z")})`} disabled={!canUndo || readOnly} onClick={() => void undo()}>
            <Undo2 />
          </ToolButton>
          <ToolButton
            label={`다시 실행 (${IS_MAC ? "⌘⇧Z" : "Ctrl+Y"})`}
            disabled={!canRedo || readOnly}
            onClick={() => void redo()}
          >
            <Redo2 />
          </ToolButton>
        </GlassGroup>

        <div className="relative w-52">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) nextMatch();
              if (e.key === "Escape") setQuery("");
            }}
            placeholder={`이름 (${shortcut("F")})`}
            className="glass h-8 rounded-full pr-12 pl-8 shadow-none dark:bg-(--glass)"
          />
          {query && (
            <span className="absolute top-1/2 right-2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground">
              {matches.length ? `${matchIdx + 1}/${matches.length}` : "0"}
            </span>
          )}
        </div>

        <GlassGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="rounded-full" disabled={readOnly}>
                <ArrowDownUp data-icon="inline-start" />
                번호
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuItem
                onSelect={() => void actions.renumber(Array.from({ length: classCount }, (_, i) => i + 1))}
              >
                전체 반 가나다순 재정렬
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openDialog({ kind: "reading", studentIds: "all" })}>
                로마자 이름 한글 발음 입력…
                {noReading > 0 && (
                  <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px]">
                    {noReading}
                  </Badge>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => openDialog({ kind: "reset" })}>
                나이스 기본 편성으로 되돌리기…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => openDialog({ kind: "separation" })}>
            <ShieldAlert data-icon="inline-start" />
            분리 학생
            {violations.length > 0 && (
              <Badge variant="destructive" className="ml-1 h-4 px-1 text-[10px]">
                {violations.length}
              </Badge>
            )}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="rounded-full">
                보기
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuLabel>표시</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={prefs.showPrev} onCheckedChange={(v) => setPrefs({ showPrev: !!v })}>
                이전 반
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={prefs.showMemo} onCheckedChange={(v) => setPrefs({ showMemo: !!v })}>
                메모
              </DropdownMenuCheckboxItem>
              {hasPdf && (
                <>
                  <DropdownMenuCheckboxItem
                    checked={prefs.showGender}
                    onCheckedChange={(v) => setPrefs({ showGender: !!v })}
                  >
                    성별
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={prefs.showBirth}
                    onCheckedChange={(v) => setPrefs({ showBirth: !!v })}
                  >
                    생년월일
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={prefs.showScore}
                    onCheckedChange={(v) => setPrefs({ showScore: !!v })}
                  >
                    기준성적
                  </DropdownMenuCheckboxItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </GlassGroup>

        <GlassGroup>
          <ToolButton label="통계" active={prefs.statsOpen} onClick={() => setPrefs({ statsOpen: !prefs.statsOpen })}>
            <BarChart3 />
          </ToolButton>
          <ToolButton
            label="변경 이력"
            active={prefs.historyOpen}
            onClick={() => setPrefs({ historyOpen: !prefs.historyOpen })}
          >
            <History />
          </ToolButton>
        </GlassGroup>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="glass h-8 rounded-full pr-2.5! pl-3.5!">
              파일
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-48 whitespace-nowrap">
            <DropdownMenuItem disabled={readOnly} onSelect={() => openDialog({ kind: "pdf" })}>
              {workspace.pdfFileName ? "PDF 다시 가져오기…" : "기준성적 PDF 가져오기…"}
            </DropdownMenuItem>
            {hasPdf && (
              <DropdownMenuItem disabled={readOnly} onSelect={() => openDialog({ kind: "twins" })}>
                쌍둥이 후보 검토…
                {twinCount > 0 && (
                  <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px]">
                    {twinCount}
                  </Badge>
                )}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void openWorkFileWithDialog()}>
              다른 파일 열기…
              <DropdownMenuShortcut>{shortcut("O")}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={saveWorkFileAsWithDialog}>
              다른 이름으로 저장…
              <DropdownMenuShortcut>{shortcut("S", { shift: true })}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={saveWorkFileCopyWithDialog}>사본 저장(백업)…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openDialog({ kind: "shortcuts" })}>
              단축키…
              <DropdownMenuShortcut>F1</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog({ kind: "settings" })}>설정 및 정보…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={closeWorkFile}>닫기</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          size="sm"
          className="h-8 rounded-full pr-3.5! pl-3! shadow-sm"
          onClick={() => openDialog({ kind: "export" })}
        >
          <Download data-icon="inline-start" />
          내보내기
        </Button>
      </TitleBar>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <BalanceMeters stats={stats} showPdf={hasPdf} />
          {prefs.statsOpen && <StatsPanel stats={stats} showPdf={hasPdf} />}

          {(selStudents.length > 0 || highlight.size > 0) && (
            <div className="glass-strong fixed bottom-10 left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-full py-1.5 pr-1.5 pl-5 text-sm">
              {selStudents.length > 0 ? (
                <>
                  <span className="font-medium">
                    선택: {selStudents.map((s) => `${s.curClass}반 ${s.nameNorm}`).join(", ")}
                  </span>
                  {!readOnly && canSwap && (
                    <Button
                      size="sm"
                      onClick={() => {
                        clearSelection();
                        void actions.swap(selStudents[0].id, selStudents[1].id);
                      }}
                    >
                      <ArrowLeftRight data-icon="inline-start" />두 학생 바꾸기
                    </Button>
                  )}
                  {!readOnly && selStudents.length === 1 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline">
                          다른 반으로 이동
                          <ChevronDown data-icon="inline-end" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {Array.from({ length: classCount }, (_, i) => i + 1).map((c) => (
                          <DropdownMenuItem
                            key={c}
                            disabled={c === selStudents[0].curClass}
                            onSelect={() => {
                              clearSelection();
                              void actions.move(selStudents[0].id, c);
                            }}
                          >
                            {c}반{c === selStudents[0].origClass && " (원래 반)"}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {selStudents.length === 2 && !canSwap && (
                    <span className="text-muted-foreground">같은 반 학생끼리는 바꿀 수 없습니다.</span>
                  )}
                  {selStudents.length === 1 && (
                    <span className="text-muted-foreground">다른 반 학생을 하나 더 고르면 바꿀 수 있습니다.</span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">강조 표시 {highlight.size}명</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  clearSelection();
                  setHighlight([]);
                }}
              >
                <X data-icon="inline-start" />
                해제 (Esc)
              </Button>
            </div>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={collision}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              setDragId(null);
              setPreviewViolation(new Set());
            }}
          >
            {/* 테두리는 스크롤 영역 자체에 둔다. 여백은 바깥 div가 맡아서, 스크롤된 칸이 테두리 밖으로 비치지 않는다. */}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col px-3 pb-2",
                // 아래쪽 선택 막대가 마지막 줄을 가리지 않게
                (selStudents.length > 0 || highlight.size > 0) && "pb-20",
              )}
            >
              <main className="glass-strong min-h-0 flex-1 overflow-auto rounded-2xl select-none">
                <div className="flex w-max min-w-full">
                  <NumberAxis rows={rows} pdf={hasPdf} />
                  {classes.map((c) => (
                    <ClassColumn
                      key={c.cls}
                      cls={c.cls}
                      classCount={classCount}
                      rows={rows}
                      slotsByNumber={c.slotsByNumber}
                      stats={stats.classes[c.cls - 1]}
                      overallMean={stats.overallMean}
                      devScale={devScale}
                      minWidth={colMinWidth}
                      numbering={numberingOf({ students, gaps, classStates, classCount }, c.cls)}
                      violations={vByClass.get(c.cls) ?? []}
                      studentIssues={studentIssues}
                      ruleKinds={ruleKinds}
                      showPdf={hasPdf}
                      readOnly={readOnly}
                      nameOf={nameOf}
                    />
                  ))}
                </div>
              </main>
            </div>
            <DragOverlay dropAnimation={null}>
              {dragStudent && (
                <div className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-lg">
                  {dragStudent.curClass}반 {dragStudent.nameNorm}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">반 위: 이동 · 학생 위: 바꾸기</span>
                </div>
              )}
            </DragOverlay>
          </DndContext>

          <footer className="shrink-0 px-5 pt-0.5 pb-2 text-xs text-muted-foreground">
            모든 변경은 파일에 바로 저장됩니다. 학생을 끌어 다른 반 위에 놓으면 이동, 다른 반 학생 위에 놓으면 바꾸기.
            이동·바꾸기한 반은 가나다순으로 번호를 다시 매깁니다.
          </footer>
        </div>
        {prefs.historyOpen && <HistoryPanel />}
      </div>

      <BoardDialogs />
      <SeparationDialog onOpenTwins={() => openDialog({ kind: "twins" })} />
      <TwinReviewDialog open={dialog?.kind === "twins"} onClose={closeDialog} />
      <ExportDialog />
      <SettingsDialog open={dialog?.kind === "settings"} onOpenChange={(o) => !o && closeDialog()} />
      <ShortcutsDialog open={dialog?.kind === "shortcuts"} onOpenChange={(o) => !o && closeDialog()} />
      <PdfImportDialog
        open={dialog?.kind === "pdf"}
        onOpenChange={(o) => !o && closeDialog()}
        onApplied={() => {
          // PDF 반영 직후 쌍둥이 후보가 있으면 검토 화면을 띄운다.
          const s = useWorkspace.getState();
          if (twinCandidates(s.students, s.rules, s.dismissedTwins).length > 0) openDialog({ kind: "twins" });
        }}
      />
    </div>
  );
}

/** 유리 캡슐: 관련 도구 단추를 한 덩어리로 묶는다. */
function GlassGroup({ children }: { children: React.ReactNode }) {
  return <div className="glass flex h-8 items-center gap-0.5 rounded-full px-0.5">{children}</div>;
}

function ToolButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7 rounded-full", active && "bg-accent text-accent-foreground hover:bg-accent")}
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
