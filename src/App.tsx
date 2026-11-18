import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BoardScreen } from "@/features/board/BoardScreen";
import { ImportXlsxScreen } from "@/features/import-xlsx/ImportXlsxScreen";
import { StartScreen } from "@/features/workspace/StartScreen";
import { useWorkspace } from "@/store/workspace";

export default function App() {
  const workspace = useWorkspace((s) => s.workspace);
  const refresh = useWorkspace((s) => s.refresh);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 개발 중 새로고침해도 Rust 쪽에 열린 파일이 있으면 이어서 보여 준다.
    refresh()
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [refresh]);

  let screen = null;
  if (ready) {
    if (!workspace) screen = <StartScreen />;
    else if (workspace.studentCount === 0) screen = <ImportXlsxScreen />;
    else screen = <BoardScreen />;
  }

  return (
    <TooltipProvider delayDuration={300}>
      {screen}
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
