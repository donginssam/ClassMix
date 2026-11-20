import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FileText, Link2Off, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { matchPdfRows, type Match, type MatchResult } from "@/domain/matching";
import type { PdfParseResult, PdfRow } from "@/domain/pdfTable";
import { api, errorMessage, type PdfLink, type PdfRowInput, type Student } from "@/lib/api";
import { useDevSamples } from "@/lib/useDevSamples";
import { formatScore } from "@/lib/format";
import { useFileDrop } from "@/lib/useFileDrop";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";

type Stage =
  | { kind: "pick"; error?: string }
  | { kind: "parsing"; path: string }
  | { kind: "review"; path: string; parsed: PdfParseResult; match: MatchResult }
  | { kind: "applying" };

const METHOD_LABEL: Record<Match["method"], string> = {
  "next_seat+name": "진급반·번호+성명",
  "prev_seat+name": "이전반·번호+성명",
  name: "성명만 일치",
  manual: "직접 연결",
};

export function PdfImportDialog({
  open,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** 반영을 마치고 대화상자를 닫은 뒤 호출(쌍둥이 후보 검토로 이어짐) */
  onApplied?: () => void;
}) {
  const students = useWorkspace((s) => s.students);
  const refresh = useWorkspace((s) => s.refresh);
  const [stage, setStage] = useState<Stage>({ kind: "pick" });

  const load = async (path: string) => {
    setStage({ kind: "parsing", path });
    try {
      const { parsePdf } = await import("@/lib/pdf");
      const parsed = await parsePdf(await api.readPdfFile(path));
      if (parsed.rows.length === 0) {
        setStage({ kind: "pick", error: parsed.problems.join(" ") || "PDF에서 학생 행을 찾지 못했습니다." });
        return;
      }
      const match = matchPdfRows(
        parsed.rows,
        students.map((s) => ({
          id: s.id,
          studentNo: s.studentNo,
          name: s.name,
          prevClass: s.prevClass,
          prevNumber: s.prevNumber,
          origClass: s.origClass,
          origNumber: s.origNumber,
        })),
      );
      setStage({ kind: "review", path, parsed, match });
    } catch (e) {
      setStage({ kind: "pick", error: `PDF를 읽지 못했습니다. ${errorMessage(e)}` });
    }
  };

  const pick = async () => {
    const path = await openDialog({
      title: "나이스 반편성내역 PDF 선택",
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (path) await load(path);
  };

  const hovering = useFileDrop(["pdf"], load, open && stage.kind === "pick");
  const samples = useDevSamples();

  const close = (o: boolean) => {
    if (!o && stage.kind !== "applying" && stage.kind !== "parsing") {
      onOpenChange(false);
      setStage({ kind: "pick" });
    }
  };

  const apply = async (
    path: string,
    parsed: PdfParseResult,
    links: Map<number, { studentId: number; method: Match["method"] }>,
  ) => {
    setStage({ kind: "applying" });
    try {
      const rows: PdfRowInput[] = parsed.rows.map(toInput);
      const linkList: PdfLink[] = [...links].map(([i, l]) => ({
        rowIndex: i,
        studentId: l.studentId,
        method: l.method,
      }));
      const rep = await api.applyPdfMapping(path, rows, linkList);
      await refresh();
      toast.success(`기준성적을 ${rep.linked}명에게 반영했습니다.`, {
        description: rep.unlinkedRows > 0 ? `연결하지 않은 PDF 행 ${rep.unlinkedRows}개는 저장만 했습니다.` : undefined,
      });
      onOpenChange(false);
      setStage({ kind: "pick" });
      onApplied?.();
    } catch (e) {
      toast.error("반영하지 못했습니다.", { description: errorMessage(e) });
      setStage({ kind: "pick" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="flex max-h-[90vh] flex-col sm:max-w-5xl"
        showCloseButton={stage.kind === "pick" || stage.kind === "review"}
      >
        <DialogHeader>
          <DialogTitle>PDF 가져오기 — 기준성적 매핑</DialogTitle>
          <DialogDescription>
            나이스 "반편성내역[배정반기준]" PDF에서 기준성적·성별·생년월일을 읽어 XLSX 학생에게 연결합니다.
          </DialogDescription>
        </DialogHeader>

        {stage.kind === "pick" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={pick}
              className={cn(
                "flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors hover:border-primary/60 hover:bg-primary/5",
                hovering && "border-primary bg-primary/5",
              )}
            >
              <FileText className="size-9 text-muted-foreground" />
              <span className="font-semibold">반편성내역 PDF를 끌어다 놓거나 눌러서 선택</span>
              <span className="text-sm text-muted-foreground">이미 반영한 PDF가 있으면 새 PDF 내용으로 바뀝니다.</span>
            </button>
            {samples && (
              <Button variant="link" size="sm" onClick={() => load(samples.pdf)}>
                샘플 PDF 바로 적용(개발용)
              </Button>
            )}
            {stage.error && (
              <Alert variant="destructive">
                <AlertTitle>읽지 못했습니다</AlertTitle>
                <AlertDescription>{stage.error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {(stage.kind === "parsing" || stage.kind === "applying") && (
          <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-8 animate-spin" />
            {stage.kind === "parsing" ? "PDF 표를 읽는 중…" : "작업 파일에 반영하는 중…"}
          </div>
        )}

        {stage.kind === "review" && (
          <Review
            key={stage.path}
            path={stage.path}
            parsed={stage.parsed}
            match={stage.match}
            students={students}
            onCancel={() => setStage({ kind: "pick" })}
            onApply={(links) => apply(stage.path, stage.parsed, links)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function toInput(r: PdfRow): PdfRowInput {
  return {
    page: r.page,
    grade: r.grade,
    class: r.class,
    number: r.number,
    name: r.name,
    birthDate: r.birthDate,
    gender: r.gender,
    baseScore: r.baseScore,
    prevGrade: r.prevGrade,
    prevClass: r.prevClass,
    prevNumber: r.prevNumber,
    note: r.note,
  };
}

type LinkMap = Map<number, { studentId: number; method: Match["method"] }>;

function Review({
  path,
  parsed,
  match,
  students,
  onCancel,
  onApply,
}: {
  path: string;
  parsed: PdfParseResult;
  match: MatchResult;
  students: Student[];
  onCancel: () => void;
  onApply: (links: LinkMap) => void;
}) {
  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const auto = match.matches.filter((m) => m.confidence === "auto");
  const review = match.matches.filter((m) => m.confidence === "review");
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [manual, setManual] = useState<Map<number, number>>(new Map());

  const links: LinkMap = useMemo(() => {
    const m: LinkMap = new Map();
    for (const x of auto) m.set(x.rowIndex, { studentId: x.studentId, method: x.method });
    for (const x of review)
      if (!rejected.has(x.rowIndex)) m.set(x.rowIndex, { studentId: x.studentId, method: x.method });
    for (const [row, sid] of manual) m.set(row, { studentId: sid, method: "manual" });
    return m;
  }, [auto, review, rejected, manual]);

  const linkedStudentIds = new Set([...links.values()].map((l) => l.studentId));
  const unmatchedRows = [
    ...match.unmatchedRows,
    ...review.filter((x) => rejected.has(x.rowIndex)).map((x) => x.rowIndex),
  ].sort((a, b) => a - b);
  const freeStudents = students
    .filter((s) => !linkedStudentIds.has(s.id))
    .sort((a, b) => a.origClass - b.origClass || a.origNumber - b.origNumber);
  const pendingRows = unmatchedRows.filter((i) => !manual.has(i));
  const notes = [...parsed.problems, ...parsed.pages.filter((p) => p.message).map((p) => p.message!)];
  const failedPages = parsed.pages.filter((p) => !p.ok);

  return (
    <>
      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label="PDF 학생 행" value={`${parsed.rows.length}행`} sub={`${parsed.pages.length}쪽`} />
        <Stat label="연결됨" value={`${links.size}명`} sub={`/ XLSX ${students.length}명`} tone="ok" />
        <Stat label="확인 필요" value={`${review.length}건`} tone={review.length ? "warn" : undefined} />
        <Stat
          label="미연결"
          value={`${pendingRows.length}행 · ${students.length - links.size}명`}
          sub="PDF 행 · XLSX 학생"
          tone={pendingRows.length || students.length - links.size ? "warn" : undefined}
        />
      </div>

      {(notes.length > 0 || failedPages.length > 0) && (
        <Alert variant={failedPages.length ? "destructive" : "default"}>
          <AlertTriangle />
          <AlertTitle>{failedPages.length ? "PDF를 일부 읽지 못했습니다" : "PDF 확인 사항"}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Tabs
        defaultValue={review.length ? "review" : pendingRows.length ? "unmatched" : "auto"}
        className="min-h-0 flex-1"
      >
        <TabsList>
          <TabsTrigger value="auto">자동 확정 {auto.length}</TabsTrigger>
          <TabsTrigger value="review">확인 필요 {review.length}</TabsTrigger>
          <TabsTrigger value="unmatched">PDF에만 있음 {unmatchedRows.length}</TabsTrigger>
          <TabsTrigger value="xlsx-only">XLSX에만 있음 {students.length - links.size}</TabsTrigger>
        </TabsList>

        <TabsContent value="auto" className="min-h-0 overflow-y-auto">
          <LinkTable rows={parsed.rows} items={auto.map((m) => ({ m, s: byId.get(m.studentId)! }))} />
        </TabsContent>

        <TabsContent value="review" className="min-h-0 overflow-y-auto">
          {review.length === 0 ? (
            <Empty>확인이 필요한 연결이 없습니다.</Empty>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                반·번호로는 확인되지 않고 성명만 같은 경우입니다. 맞지 않으면 [연결 끊기]를 누르세요.
              </p>
              <LinkTable
                rows={parsed.rows}
                items={review.map((m) => ({ m, s: byId.get(m.studentId)! }))}
                rejected={rejected}
                showPrev
                onToggle={(row) =>
                  setRejected((prev) => {
                    const next = new Set(prev);
                    if (next.has(row)) next.delete(row);
                    else next.add(row);
                    return next;
                  })
                }
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="unmatched" className="min-h-0 overflow-y-auto">
          {unmatchedRows.length === 0 ? (
            <Empty>모든 PDF 행이 연결되었습니다.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1.5 font-normal">PDF</th>
                  <th className="py-1.5 font-normal">연결할 학생</th>
                </tr>
              </thead>
              <tbody>
                {unmatchedRows.map((i) => {
                  const r = parsed.rows[i];
                  const chosen = manual.get(i);
                  const options = [...(chosen != null ? [byId.get(chosen)!] : []), ...freeStudents];
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1.5">
                        <PdfCell r={r} />
                      </td>
                      <td className="py-1.5">
                        <Select
                          value={chosen != null ? String(chosen) : "none"}
                          onValueChange={(v) =>
                            setManual((prev) => {
                              const next = new Map(prev);
                              if (v === "none") next.delete(i);
                              else next.set(i, Number(v));
                              return next;
                            })
                          }
                        >
                          <SelectTrigger className="w-80">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">연결 안 함</SelectItem>
                            {options.map((s) => (
                              <SelectItem key={s.id} value={String(s.id)}>
                                {s.origClass}반 {s.origNumber}번 {s.nameNorm} (이전 {s.prevClass}반 {s.prevNumber}번)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </TabsContent>

        <TabsContent value="xlsx-only" className="min-h-0 overflow-y-auto">
          {freeStudents.length === 0 ? (
            <Empty>모든 XLSX 학생이 PDF와 연결되었습니다.</Empty>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                이 학생들은 기준성적·성별 없이 반편성됩니다. [PDF에만 있음] 탭에서 직접 연결할 수 있습니다.
              </p>
              <ul className="grid grid-cols-2 gap-x-6 text-sm md:grid-cols-3">
                {freeStudents.map((s) => (
                  <li key={s.id} className="py-0.5 tabular-nums">
                    <span className="text-muted-foreground">
                      {s.origClass}반 {s.origNumber}번
                    </span>{" "}
                    <span className="font-medium">{s.nameNorm}</span>{" "}
                    <span className="text-muted-foreground">
                      (이전 {s.prevClass}반 {s.prevNumber}번)
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </TabsContent>
      </Tabs>

      <DialogFooter className="items-center">
        <span className="mr-auto truncate text-xs text-muted-foreground">{path}</span>
        <Button variant="outline" onClick={onCancel}>
          다른 PDF 선택
        </Button>
        <Button onClick={() => onApply(links)} disabled={links.size === 0}>
          {links.size}명에게 반영
        </Button>
      </DialogFooter>
    </>
  );
}

function PdfCell({ r, showPrev = false }: { r: PdfRow; showPrev?: boolean }) {
  return (
    <span className="tabular-nums">
      <span className="text-muted-foreground">
        {r.class}반 {r.number}번
      </span>{" "}
      <span className="font-medium">{r.name}</span>{" "}
      <span className="text-muted-foreground">
        {r.gender ?? ""} {r.birthRaw} · {formatScore(r.baseScore)}
        {showPrev && r.prevClass != null && ` · 이전 ${r.prevClass}반 ${r.prevNumber ?? "?"}번`}
      </span>
    </span>
  );
}

function LinkTable({
  rows,
  items,
  rejected,
  onToggle,
  showPrev = false,
}: {
  rows: PdfRow[];
  items: { m: Match; s: Student }[];
  rejected?: Set<number>;
  onToggle?: (row: number) => void;
  /** 성명만으로 이은 연결을 사람이 확인할 때, 양쪽 이전 반·번호를 함께 보여 준다. */
  showPrev?: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b text-left">
          <th className="py-1.5 font-normal">PDF</th>
          <th className="py-1.5 font-normal">XLSX 학생</th>
          <th className="py-1.5 font-normal">근거</th>
          {onToggle && <th />}
        </tr>
      </thead>
      <tbody>
        {items.map(({ m, s }) => {
          const off = rejected?.has(m.rowIndex);
          return (
            <tr key={m.rowIndex} className={cn("border-b last:border-0", off && "opacity-40")}>
              <td className="py-1">
                <PdfCell r={rows[m.rowIndex]} showPrev={showPrev} />
              </td>
              <td className="py-1 tabular-nums">
                <span className="text-muted-foreground">
                  {s.origClass}반 {s.origNumber}번
                </span>{" "}
                <span className="font-medium">{s.nameNorm}</span>
                {showPrev && (
                  <span className="text-muted-foreground">
                    {" "}
                    (이전 {s.prevClass}반 {s.prevNumber}번)
                  </span>
                )}
              </td>
              <td className="py-1">
                <Badge variant={m.confidence === "auto" ? "secondary" : "outline"}>{METHOD_LABEL[m.method]}</Badge>
              </td>
              {onToggle && (
                <td className="py-1 text-right">
                  <Button size="xs" variant="ghost" onClick={() => onToggle(m.rowIndex)}>
                    {off ? (
                      "다시 연결"
                    ) : (
                      <>
                        <Link2Off data-icon="inline-start" />
                        연결 끊기
                      </>
                    )}
                  </Button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-muted/40 px-3 py-2",
        tone === "warn" && "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40",
      )}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}
