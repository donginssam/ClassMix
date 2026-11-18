import { useMemo, useState } from "react";
import { ChevronDown, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Gap, Student } from "@/lib/api";
import { closeWorkFile, saveWorkFileAsWithDialog, saveWorkFileCopyWithDialog } from "@/lib/fileActions";
import { useWorkspace } from "@/store/workspace";
import { PdfImportDialog } from "@/features/import-pdf/PdfImportDialog";
import { ClassCard } from "./ClassCard";

export interface ClassSlot {
  kind: "student" | "gap";
  number: number;
  student?: Student;
  gap?: Gap;
}

export function BoardScreen() {
  const workspace = useWorkspace((s) => s.workspace)!;
  const students = useWorkspace((s) => s.students);
  const gaps = useWorkspace((s) => s.gaps);
  const [pdfOpen, setPdfOpen] = useState(false);
  const hasPdf = workspace.pdfLinkedCount > 0;

  const classes = useMemo(() => {
    const count = workspace.classCount ?? 0;
    return Array.from({ length: count }, (_, i) => {
      const cls = i + 1;
      const slots: ClassSlot[] = [
        ...students
          .filter((s) => s.curClass === cls)
          .map((s) => ({ kind: "student" as const, number: s.curNumber, student: s })),
        ...gaps.filter((g) => g.class === cls).map((g) => ({ kind: "gap" as const, number: g.number, gap: g })),
      ].sort((a, b) => a.number - b.number);
      return { cls, slots };
    });
  }, [students, gaps, workspace.classCount]);

  const sameNameCount = students.filter((s) => s.sameName).length;

  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-5 py-2.5 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold">{workspace.fileName}</h1>
            {workspace.readOnly && <Badge variant="secondary">읽기 전용</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {workspace.targetGrade} · {workspace.classCount}개 반 · 학생 {workspace.studentCount}명
            {workspace.xlsxFileName && ` · ${workspace.xlsxFileName}`}
          </p>
        </div>

        <Button variant={hasPdf ? "outline" : "default"} onClick={() => setPdfOpen(true)} disabled={workspace.readOnly}>
          <FileText data-icon="inline-start" />
          {hasPdf ? "PDF 다시 가져오기" : "PDF 가져오기(기준성적)"}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              파일
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={saveWorkFileAsWithDialog}>다른 이름으로 저장…</DropdownMenuItem>
            <DropdownMenuItem onSelect={saveWorkFileCopyWithDialog}>사본 저장(백업)…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={closeWorkFile}>닫기</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b bg-background px-5 py-2 text-sm">
        <span>
          PDF 기준성적{" "}
          {hasPdf ? (
            <span className="font-medium tabular-nums">
              {workspace.pdfLinkedCount}/{workspace.studentCount}명 반영
            </span>
          ) : (
            <span className="text-muted-foreground">없음 — 성적 없이 조정</span>
          )}
        </span>
        <span>
          동명이인 <span className="font-medium tabular-nums">{sameNameCount}명</span>
        </span>
        <span>
          빈 번호 <span className="font-medium tabular-nums">{gaps.length}개</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">모든 변경은 파일에 바로 저장됩니다.</span>
      </div>

      <main className="grid flex-1 grid-cols-1 gap-4 p-5 lg:grid-cols-2 2xl:grid-cols-4 xl:grid-cols-3">
        {classes.map((c) => (
          <ClassCard key={c.cls} cls={c.cls} slots={c.slots} showPdf={hasPdf} />
        ))}
      </main>

      <PdfImportDialog open={pdfOpen} onOpenChange={setPdfOpen} />
    </div>
  );
}
