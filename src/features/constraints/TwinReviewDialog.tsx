import { useMemo, useState } from "react";
import { toast } from "sonner";
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
import { twinCandidates, type TwinCandidate } from "@/domain/siblings";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { studentLabel } from "./StudentPicker";

type Choice = "register" | "dismiss" | "later";

export function useTwinCandidates(): TwinCandidate[] {
  const students = useWorkspace((s) => s.students);
  const rules = useWorkspace((s) => s.rules);
  const dismissed = useWorkspace((s) => s.dismissedTwins);
  return useMemo(() => twinCandidates(students, rules, dismissed), [students, rules, dismissed]);
}

/** 쌍둥이 후보 검토: 후보마다 [쌍둥이로 등록] / [아님] / [나중에]. "가능" 등급은 기본으로 등록하지 않는다. */
export function TwinReviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const candidates = useTwinCandidates();
  const students = useWorkspace((s) => s.students);
  const refresh = useWorkspace((s) => s.refresh);
  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [busy, setBusy] = useState(false);
  // 열 때마다 기본 선택(유력 → 등록, 가능 → 아님)으로 시작한다.
  const [openedFor, setOpenedFor] = useState(false);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) setChoices(new Map(candidates.map((c) => [c.key, c.grade === "likely" ? "register" : "dismiss"])));
  }

  const save = async () => {
    const register = candidates.filter((c) => choices.get(c.key) === "register").map((c) => c.studentIds);
    const dismiss = candidates.filter((c) => choices.get(c.key) === "dismiss").map((c) => c.studentIds);
    setBusy(true);
    try {
      await api.resolveTwinCandidates(register, dismiss);
      await refresh();
      toast.success(`쌍둥이 규칙 ${register.length}개를 만들었습니다.`, {
        description: dismiss.length ? `${dismiss.length}건은 "아님"으로 넘겨 다시 묻지 않습니다.` : undefined,
      });
      onClose();
    } catch (e) {
      toast.error("저장하지 못했습니다.", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>쌍둥이 후보 {candidates.length}건</DialogTitle>
          <DialogDescription>
            나이스 자료에는 쌍둥이 여부가 없어 생년월일로 후보를 찾았습니다. <b>유력</b>은 생년월일과 성이 같고,{" "}
            <b>가능</b>은 생년월일만 같습니다. 생일이 겹치는 우연도 흔하기 때문입니다. 쌍둥이로 등록하면 서로 다른
            반이어야 하는 규칙이 생깁니다.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">검토할 후보가 없습니다.</p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {candidates.map((c) => {
              const choice = choices.get(c.key) ?? "later";
              return (
                <li key={c.key} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                  <Badge variant={c.grade === "likely" ? "default" : "outline"}>
                    {c.grade === "likely" ? "유력" : "가능"}
                  </Badge>
                  <span className="text-xs tabular-nums text-muted-foreground">{c.birthDate}</span>
                  <span className="flex flex-1 flex-wrap gap-x-3 text-sm">
                    {c.studentIds.map((id) => {
                      const s = byId.get(id);
                      return s ? (
                        <span key={id}>
                          {studentLabel(s)}{" "}
                          <span className="text-xs tabular-nums text-muted-foreground">{s.curClass}반</span>
                        </span>
                      ) : null;
                    })}
                  </span>
                  <span className="flex overflow-hidden rounded-md border text-xs">
                    {(
                      [
                        ["register", "쌍둥이로 등록"],
                        ["dismiss", "아님"],
                        ["later", "나중에"],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        className={cn(
                          "px-2 py-1 hover:bg-muted",
                          choice === v && "bg-primary text-primary-foreground hover:bg-primary",
                        )}
                        onClick={() => setChoices(new Map(choices).set(c.key, v))}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button onClick={() => void save()} disabled={busy || candidates.length === 0}>
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
