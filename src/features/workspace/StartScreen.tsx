import { useCallback, useEffect, useState } from "react";
import { FilePlus2, FolderOpen, FileWarning, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type RecentFile } from "@/lib/api";
import { createWorkFileWithDialog, openWorkFilePath, openWorkFileWithDialog } from "@/lib/fileActions";
import { useFileDrop } from "@/lib/useFileDrop";
import { cn } from "@/lib/utils";

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

export function StartScreen() {
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [busy, setBusy] = useState(false);

  const loadRecent = useCallback(() => {
    api
      .listRecentFiles()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);
  useEffect(loadRecent, [loadRecent]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      loadRecent();
    }
  };

  const hovering = useFileDrop(["mix"], (path) => run(() => openWorkFilePath(path)));

  return (
    <div
      className={cn(
        "flex min-h-svh items-center justify-center bg-board p-8 transition-colors",
        hovering && "bg-primary/5",
      )}
    >
      <div className="grid w-full max-w-4xl gap-10 md:grid-cols-[1fr_1.2fr]">
        <section className="flex flex-col justify-center gap-6">
          <div>
            <p className="text-sm font-medium text-muted-foreground">나이스 진급 반편성 도우미</p>
            <h1 className="mt-1 text-4xl font-bold tracking-tight">ClassMix</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              나이스에서 기본 편성 후 내려받은 XLSX와 반편성내역 PDF를 불러와 반을 조정하고, 나이스 업로드용 XLSX로
              내보냅니다.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              className="h-11 justify-start text-base"
              disabled={busy}
              onClick={() => run(createWorkFileWithDialog)}
            >
              <FilePlus2 data-icon="inline-start" />새 반편성 만들기
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-11 justify-start text-base"
              disabled={busy}
              onClick={() => run(openWorkFileWithDialog)}
            >
              <FolderOpen data-icon="inline-start" />
              파일 열기
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            반편성 1건은 <span className="font-medium text-foreground">.mix 파일</span> 하나에 저장됩니다. 고치는 즉시
            자동 저장되며, 파일을 USB 등으로 옮겨 다른 PC에서 이어서 작업할 수 있습니다. 재부팅하면 C 드라이브가
            초기화되는 PC라면 D 드라이브나 USB에 저장하세요.
          </p>
        </section>

        <section className="rounded-xl border bg-background p-4 shadow-xs">
          <h2 className="px-2 pb-2 text-sm font-semibold">최근 파일</h2>
          {recent.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
              <p>최근에 연 파일이 없습니다.</p>
              <p className="text-xs">.mix 파일을 이 창에 끌어다 놓아도 열립니다.</p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {recent.map((f) => (
                <li key={f.path} className="group flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!f.exists || busy}
                    onClick={() => run(() => openWorkFilePath(f.path))}
                    className="flex min-w-0 flex-1 flex-col rounded-lg px-2 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {!f.exists && <FileWarning className="size-3.5 shrink-0 text-muted-foreground" />}
                      {f.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {f.exists ? f.path : "파일을 찾을 수 없습니다"} · {formatDate(f.openedAt)}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100"
                    aria-label="목록에서 지우기"
                    onClick={() => api.removeRecentFile(f.path).then(loadRecent)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
