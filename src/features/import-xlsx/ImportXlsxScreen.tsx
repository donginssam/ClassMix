import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type ImportReport } from "@/lib/api";
import { closeWorkFile } from "@/lib/fileActions";
import { useDevSamples } from "@/lib/useDevSamples";
import { useFileDrop } from "@/lib/useFileDrop";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { ImportReportDialog } from "./ImportReportDialog";

export function ImportXlsxScreen() {
  const workspace = useWorkspace((s) => s.workspace)!;
  const refresh = useWorkspace((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const samples = useDevSamples();

  const importPath = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.importXlsx(path);
      setReport(res.report);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const path = await open({
      title: "나이스 진급반편성 XLSX 선택",
      multiple: false,
      filters: [{ name: "엑셀 파일", extensions: ["xlsx"] }],
    });
    if (path) await importPath(path);
  };

  const hovering = useFileDrop(["xlsx"], importPath, !busy && !report && !workspace.readOnly);

  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="flex items-center justify-between border-b bg-background px-6 py-3">
        <div>
          <p className="text-xs text-muted-foreground">ClassMix</p>
          <h1 className="text-base font-semibold">{workspace.fileName}</h1>
        </div>
        <Button variant="ghost" onClick={closeWorkFile}>
          닫기
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 p-8">
        <ol className="flex items-center gap-3 text-sm">
          <li className="flex items-center gap-2 font-semibold">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              1
            </span>
            XLSX 가져오기 (필수)
          </li>
          <li className="h-px flex-1 bg-border" />
          <li className="flex items-center gap-2 text-muted-foreground">
            <span className="flex size-6 items-center justify-center rounded-full border text-xs">2</span>
            PDF 가져오기 (선택)
          </li>
        </ol>

        <button
          type="button"
          onClick={pick}
          disabled={busy || workspace.readOnly}
          className={cn(
            "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed bg-background px-6 py-14 text-center transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60",
            hovering && "border-primary bg-primary/5",
          )}
        >
          {busy ? (
            <Loader2 className="size-10 animate-spin text-muted-foreground" />
          ) : (
            <FileSpreadsheet className="size-10 text-muted-foreground" />
          )}
          <span className="text-base font-semibold">
            {busy ? "가져오는 중…" : "나이스 진급반편성 XLSX를 끌어다 놓거나 눌러서 선택"}
          </span>
          <span className="max-w-md text-sm text-muted-foreground">
            나이스에서 기본 편성(이름순·성적순 등)을 마친 뒤 내려받은 업로드 양식 파일입니다. 이 파일의 양식 그대로 최종
            업로드 파일을 만듭니다.
          </span>
        </button>

        {samples && (
          <Button
            variant="link"
            size="sm"
            className="self-center"
            disabled={busy}
            onClick={() => importPath(samples.xlsx)}
          >
            샘플 XLSX 바로 적용(개발용)
          </Button>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>가져오지 못했습니다</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </main>

      <ImportReportDialog
        report={report}
        onClose={async () => {
          setReport(null);
          await refresh();
          toast.success("학생 명단을 가져왔습니다.");
        }}
      />
    </div>
  );
}
