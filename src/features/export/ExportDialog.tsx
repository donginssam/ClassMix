import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, CircleX, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { validateForExport, type Issue } from "@/domain/validate";
import { api, errorMessage, type WorkspaceInfo } from "@/lib/api";
import { fileNameOf } from "@/lib/path";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { scrollToStudent, useBoardUi } from "@/features/board/uiStore";

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** `{작업 파일명}_나이스업로드_{YYYYMMDD-HHmm}.xlsx`, 작업 파일과 같은 폴더 */
export function defaultExportPath(ws: WorkspaceInfo): string {
  const sep = ws.path.includes("\\") ? "\\" : "/";
  const dir = ws.path.slice(0, ws.path.lastIndexOf(sep) + 1);
  const base = ws.fileName.replace(/\.mix$/i, "");
  return `${dir}${base}_나이스업로드_${stamp()}.xlsx`;
}

const ICON = { error: CircleX, warning: AlertTriangle, info: Info };
const TONE = {
  error: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
};

export function ExportDialog() {
  const open = useBoardUi((s) => s.dialog?.kind === "export");
  const close = useBoardUi((s) => s.closeDialog);
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const workspace = useWorkspace((s) => s.workspace);
  const students = useWorkspace((s) => s.students);
  const gaps = useWorkspace((s) => s.gaps);
  const rules = useWorkspace((s) => s.rules);
  const classStates = useWorkspace((s) => s.classStates);
  const [busy, setBusy] = useState(false);

  const issues = useMemo<Issue[]>(
    () =>
      open && workspace
        ? validateForExport({
            students,
            gaps,
            rules,
            classStates,
            classCount: workspace.classCount ?? 0,
            hasPdf: workspace.pdfLinkedCount > 0 || !!workspace.pdfFileName,
          })
        : [],
    [open, workspace, students, gaps, rules, classStates],
  );
  if (!workspace) return null;

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  const doExport = async () => {
    const path = await save({
      title: "나이스 업로드용 XLSX 저장",
      defaultPath: defaultExportPath(workspace),
      filters: [{ name: "엑셀 파일", extensions: ["xlsx"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const rep = await api.exportXlsx(path);
      toast.success("나이스 업로드용 XLSX를 저장했습니다.", {
        description: [
          fileNameOf(rep.path),
          `학생 ${rep.rows}명 · 반·번호가 바뀐 학생 ${rep.changedStudents}명`,
          "저장한 파일을 다시 읽어 확인했습니다.",
        ].join("\n"),
        duration: 10000,
      });
      close();
    } catch (e) {
      toast.error("내보내지 못했습니다.", { description: errorMessage(e), duration: 10000 });
    } finally {
      setBusy(false);
    }
  };

  const show = (i: Issue) => {
    if (!i.studentIds?.length) return;
    setHighlight(i.studentIds);
    close();
    setTimeout(() => scrollToStudent(i.studentIds![0]), 50);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>나이스 업로드용 XLSX 내보내기</DialogTitle>
          <DialogDescription>
            가져온 원본 XLSX({workspace.xlsxFileName}) 양식 그대로 진급반코드·진급반번호만 바꿔 저장합니다. 저장한 뒤
            파일을 다시 읽어 값이 맞는지 확인합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-4 text-sm">
          <span className={cn(errors.length && "font-semibold text-red-600")}>오류 {errors.length}</span>
          <span className={cn(warnings.length && "font-semibold text-amber-600")}>경고 {warnings.length}</span>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
          {issues.map((i, n) => {
            const Icon = ICON[i.level];
            return (
              <li key={n} className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
                <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[i.level])} />
                <span className="flex-1 whitespace-pre-line">{i.message}</span>
                {i.studentIds?.length ? (
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => show(i)}>
                    보드에서 보기
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {errors.length > 0 && <p className="text-sm text-red-600">오류를 고쳐야 내보낼 수 있습니다.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            취소
          </Button>
          <Button onClick={() => void doExport()} disabled={busy || errors.length > 0}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {warnings.length ? "경고를 확인했고 저장" : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
