import { Redo2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { scrollToStudent, useBoardUi } from "./uiStore";

function time(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 변경 이력(작업 파일에 영구 저장). 항목을 누르면 관련 학생을 강조한다. */
export function HistoryPanel() {
  const history = useWorkspace((s) => s.history);
  const canUndo = useWorkspace((s) => s.canUndo);
  const canRedo = useWorkspace((s) => s.canRedo);
  const readOnly = useWorkspace((s) => s.workspace?.readOnly ?? true);
  const undo = useWorkspace((s) => s.undo);
  const redo = useWorkspace((s) => s.redo);
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const setPrefs = useBoardUi((s) => s.setPrefs);

  return (
    <aside className="glass mr-3 mb-3 flex w-64 shrink-0 flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <h2 className="flex-1 text-sm font-semibold">변경 이력</h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!canUndo || readOnly}
          onClick={() => void undo()}
          title="되돌리기"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!canRedo || readOnly}
          onClick={() => void redo()}
          title="다시 실행"
        >
          <Redo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setPrefs({ historyOpen: false })}
          title="닫기"
        >
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {history.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">아직 바꾼 것이 없습니다.</p>
        ) : (
          <ol className="divide-y">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  className={cn(
                    "w-full px-3 py-2 text-left text-sm hover:bg-muted",
                    h.undone && "text-muted-foreground line-through",
                  )}
                  onClick={() => {
                    setHighlight(h.studentIds);
                    if (h.studentIds[0]) scrollToStudent(h.studentIds[0]);
                  }}
                >
                  <div>{h.label}</div>
                  <div className="text-xs text-muted-foreground no-underline">
                    {time(h.createdAt)}
                    {h.undone && " · 되돌림"}
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
    </aside>
  );
}
