import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Clock3, FilePlus2, FileText, FileWarning, FolderOpen, Keyboard, Settings, X } from "lucide-react";
import { TitleBar } from "@/app/TitleBar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { registerAssociation, SettingsDialog, useAssociationStatus } from "@/features/settings/SettingsDialog";
import { ShortcutsDialog } from "@/features/settings/ShortcutsDialog";
import { api, type RecentFile } from "@/lib/api";
import { appDescription, classMixIcon } from "@/lib/brand";
import { createWorkFileWithDialog, openWorkFilePath, openWorkFileWithDialog } from "@/lib/fileActions";
import { isHelpKey, shortcut } from "@/lib/platform";
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const assoc = useAssociationStatus();

  const busyRef = useRef(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
      } finally {
        busyRef.current = false;
        setBusy(false);
        loadRecent();
      }
    },
    [loadRecent],
  );

  const hovering = useFileDrop("mix", (path) => run(() => openWorkFilePath(path)));

  // 단축키: Ctrl+N 새로 만들기, Ctrl+O 열기, F1/? 단축키 목록
  const dialogOpen = settingsOpen || helpOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && key === "n") {
        e.preventDefault();
        void run(createWorkFileWithDialog);
      } else if (mod && !e.shiftKey && key === "o") {
        e.preventDefault();
        void run(openWorkFileWithDialog);
      } else if (isHelpKey(e)) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen, run]);

  return (
    <div className="relative flex min-h-full flex-col">
      <TitleBar className="absolute inset-x-0 top-0 z-10 justify-end gap-1 pr-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="단축키" onClick={() => setHelpOpen(true)}>
              <Keyboard />
            </Button>
          </TooltipTrigger>
          <TooltipContent>단축키 (F1)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="설정 및 정보" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>설정 및 정보</TooltipContent>
        </Tooltip>
      </TitleBar>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(o) => {
          setSettingsOpen(o);
          if (!o) assoc.reload();
        }}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <main
        className={cn(
          "grid flex-1 place-items-center px-[clamp(1.25rem,5vw,4rem)] pt-16 pb-10",
          hovering && "-outline-offset-7 outline-2 outline-dashed outline-welcome-accent",
        )}
      >
        <div className="welcome-grid">
          <section className="flex min-w-0 flex-col gap-6">
            <div>
              <div className="flex items-center gap-3 sm:gap-4">
                <img
                  src={classMixIcon}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="size-14 shrink-0 sm:size-17"
                />
                <h1 className="welcome-wordmark" aria-label="ClassMix">
                  Class<span className="text-welcome-accent">Mix</span>
                </h1>
              </div>
              <p className="mt-5 text-xl font-semibold tracking-tight">{appDescription}</p>
              <p className="mt-2.5 max-w-96 text-[15px] leading-[1.75] break-keep text-muted-foreground">
                나이스에서 기본 편성 후 받은 XLSX와 반편성내역 PDF를 불러와 반을 조정하고, 나이스 업로드용 XLSX로
                내보냅니다.
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <Button
                size="lg"
                className="h-12 flex-auto justify-start gap-2 rounded-lg bg-welcome-accent px-3.5 text-sm font-semibold text-welcome-accent-foreground hover:bg-welcome-accent/90"
                disabled={busy}
                onClick={() => run(createWorkFileWithDialog)}
              >
                <FilePlus2 data-icon="inline-start" />새 반편성 만들기
                <kbd className="ml-auto shrink-0 font-sans text-xs font-normal opacity-85">{shortcut("N")}</kbd>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 flex-auto justify-start gap-2 rounded-lg border-welcome-line bg-welcome-surface px-3.5 text-sm font-semibold hover:bg-welcome-muted dark:border-welcome-line dark:bg-welcome-surface dark:hover:bg-welcome-muted"
                disabled={busy}
                onClick={() => run(openWorkFileWithDialog)}
              >
                <FolderOpen data-icon="inline-start" />
                파일 열기
                <kbd className="ml-auto shrink-0 font-sans text-xs font-normal text-muted-foreground">
                  {shortcut("O")}
                </kbd>
              </Button>
            </div>
            {assoc.status?.state === "moved" && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-background p-3 text-xs leading-relaxed">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="flex flex-1 flex-col gap-2">
                  <p>
                    ClassMix 실행 파일을 옮겨서 .mix 파일을 두 번 클릭해도 열리지 않을 수 있습니다. 지금 위치로 다시
                    등록하세요.
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={async () => {
                      const s = await registerAssociation();
                      if (s) assoc.setStatus(s);
                    }}
                  >
                    다시 등록
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2.5 border-t border-welcome-line pt-4">
              <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-welcome-accent" />
              <p className="grid gap-1 text-xs leading-relaxed break-keep text-muted-foreground">
                <span>
                  변경 사항은 <span className="font-semibold text-foreground">.mix 파일</span>에 자동 저장됩니다.
                </span>
                <span>파일을 옮기면 다른 PC에서도 이어서 작업할 수 있습니다.</span>
                {/* "C 드라이브", "D 드라이브"는 줄이 갈라지지 않게 붙는 공백(\u00a0)으로 잇는다. */}
                <span>
                  재부팅하면 C{"\u00a0"}드라이브가 초기화되는 PC라면
                  <br />D{"\u00a0"}드라이브나 USB에 저장하세요.
                </span>
              </p>
            </div>
          </section>

          <section
            className="glass flex min-h-64 min-w-0 flex-col rounded-3xl p-5 sm:p-6"
            aria-labelledby="recent-title"
          >
            <h2 id="recent-title" className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
              <Clock3 aria-hidden="true" className="size-4 text-welcome-accent" /> 최근 파일
            </h2>
            {recent.length === 0 ? (
              <div className="flex min-h-28 flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-welcome-muted p-4 text-center text-muted-foreground">
                <p className="text-sm font-medium text-foreground">최근에 연 파일이 없습니다.</p>
                <p className="text-xs">.mix 파일을 창에 끌어다 놓아 열 수 있습니다.</p>
                {assoc.status?.state === "none" && (
                  <p className="mt-2 max-w-xs text-xs">
                    탐색기에서 두 번 클릭해 열려면{" "}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setSettingsOpen(true)}
                    >
                      설정
                    </button>
                    에서 .mix 파일 연결을 등록하세요.
                  </p>
                )}
              </div>
            ) : (
              <ul className="flex max-h-55 flex-col gap-1 overflow-y-auto">
                {recent.map((f) => (
                  <li
                    key={f.path}
                    className="group flex items-center gap-1 rounded-lg pr-2 focus-within:bg-welcome-muted hover:bg-welcome-muted"
                  >
                    <button
                      type="button"
                      disabled={!f.exists || busy}
                      onClick={() => run(() => openWorkFilePath(f.path))}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-welcome-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-welcome-muted text-welcome-accent">
                        {f.exists ? <FileText className="size-4" /> : <FileWarning className="size-4" />}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-semibold" title={f.name}>
                          {f.name}
                        </span>
                        <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
                          <span className="truncate" title={f.path}>
                            {f.exists ? f.path : "파일을 찾을 수 없습니다"}
                          </span>
                          <span className="shrink-0">{formatDate(f.openedAt)}</span>
                        </span>
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
      </main>
    </div>
  );
}
