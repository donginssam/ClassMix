import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { BoardScreen } from "@/features/board/BoardScreen";
import { ImportXlsxScreen } from "@/features/import-xlsx/ImportXlsxScreen";
import { StartScreen } from "@/features/workspace/StartScreen";
import { UnlockScreen } from "@/features/security/UnlockScreen";
import { errorMessage } from "@/lib/api";
import { useOpenRequests } from "@/lib/useOpenRequests";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";

export default function App() {
  const workspace = useWorkspace((s) => s.workspace);
  const refresh = useWorkspace((s) => s.refresh);
  const [ready, setReady] = useState(false);
  const { theme } = useTheme();

  useEffect(() => {
    if (!isTauri()) return;
    const appearance = theme === "light" || theme === "dark" ? theme : null;
    getCurrentWindow()
      .setTheme(appearance)
      .catch((error) => {
        console.warn("Could not sync the window appearance.", error);
      });
  }, [theme]);

  useEffect(() => {
    // 개발 중 새로고침해도 Rust 쪽에 열린 파일이 있으면 이어서 보여 준다.
    refresh()
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [refresh]);

  // 탐색기 더블클릭·두 번째 실행으로 들어온 .mix 열기(첫 화면을 정한 뒤부터 받는다)
  useOpenRequests(ready);

  // 어디서도 잡지 않은 비동기 오류는 흰 화면 대신 알림으로 보여 준다.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      console.error(e.reason);
      toast.error("처리하지 못한 오류가 있습니다.", { description: errorMessage(e.reason) });
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  let screen = null;
  if (ready) {
    if (!workspace) screen = <StartScreen />;
    else if (workspace.locked) screen = <UnlockScreen />;
    else if (workspace.studentCount === 0) screen = <ImportXlsxScreen />;
    else screen = <BoardScreen />;
  }

  return (
    <TooltipProvider delayDuration={300}>
      {/* 제목 표시줄은 화면마다 맨 위 막대(TitleBar)가 맡는다. */}
      <div className={cn("flex h-svh flex-col overflow-hidden", workspace ? "bg-board" : "bg-welcome")}>
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorBoundary>{screen}</ErrorBoundary>
        </div>
      </div>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
