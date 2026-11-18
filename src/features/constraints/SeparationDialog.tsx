import { useMemo, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RULE_KIND_LABEL, ruleViolations } from "@/domain/separation";
import { api, errorMessage, type Rule, type RuleKind, type Student } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { useBoardUi } from "@/features/board/uiStore";
import { StudentChip, StudentPicker } from "./StudentPicker";

const TABS: RuleKind[] = ["group", "one_to_many", "twin", "same_name"];

const TAB_HELP: Record<RuleKind, string> = {
  group: "고른 학생이 모두 서로 다른 반이어야 합니다. (A:B:C)",
  one_to_many: "기준 학생(A)과 나머지(B·C·D)는 다른 반이어야 하고, 나머지끼리는 같은 반이어도 됩니다. (A:BCD)",
  twin: "쌍둥이(형제) 모두 서로 다른 반이어야 합니다. 학부모가 같은 반을 원하면 규칙을 끄고 사유를 적어 두세요.",
  same_name: "XLSX를 가져올 때 같은 이름(공백·대소문자 무시) 학생끼리 자동으로 만든 규칙입니다. 끄기만 할 수 있습니다.",
};

/** 분리 학생 창: 탭 4개(그룹형 / 1:N형 / 쌍둥이 / 동명이인) */
export function SeparationDialog({ onOpenTwins }: { onOpenTwins: () => void }) {
  const dialog = useBoardUi((s) => s.dialog);
  const close = useBoardUi((s) => s.closeDialog);
  const open = dialog?.kind === "separation";
  const students = useWorkspace((s) => s.students);
  const rules = useWorkspace((s) => s.rules);
  const workspace = useWorkspace((s) => s.workspace);
  const openDialog = useBoardUi((s) => s.openDialog);
  const tab = dialog?.kind === "separation" ? (dialog.tab ?? "group") : "group";
  const setTab = (t: string) => {
    if (dialog?.kind !== "separation") return;
    openDialog({ ...dialog, tab: t, preselectTab: dialog.preselectTab ?? dialog.tab ?? "group" });
  };

  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const classOf = (id: number) => byId.get(id)?.curClass;
  const preselect = dialog?.kind === "separation" ? (dialog.preselect ?? []) : [];
  // 미리 고른 학생은 처음 연 탭의 새 규칙 칸에만 넣는다.
  const preselectTab = dialog?.kind === "separation" ? (dialog.preselectTab ?? dialog.tab ?? "group") : "group";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>분리 학생</DialogTitle>
          <DialogDescription>
            규칙을 어기면 반 카드에 표시하고 내보내기 전에 경고합니다. 조작을 막지는 않습니다.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            {TABS.map((k) => {
              const list = rules.filter((r) => r.kind === k);
              const bad = list.filter((r) => ruleViolations(r, classOf).length > 0).length;
              return (
                <TabsTrigger key={k} value={k} className="gap-1.5">
                  {RULE_KIND_LABEL[k]}
                  <span className="tabular-nums text-muted-foreground">{list.length}</span>
                  {bad > 0 && <span className="size-1.5 rounded-full bg-red-500" />}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {TABS.map((k) => (
            <TabsContent key={k} value={k} className="min-h-0 flex-1 overflow-y-auto pr-1">
              <p className="mb-3 text-sm text-muted-foreground">{TAB_HELP[k]}</p>
              {k === "twin" && workspace?.pdfLinkedCount ? (
                <Button variant="outline" size="sm" className="mb-3" onClick={onOpenTwins}>
                  생년월일로 쌍둥이 후보 찾기…
                </Button>
              ) : null}
              {k !== "same_name" && !workspace?.readOnly && (
                <NewRuleForm
                  key={`${k}:${preselectTab === k ? preselect.join(",") : ""}`}
                  kind={k}
                  students={students}
                  preselect={preselectTab === k ? preselect : []}
                />
              )}
              <RuleList
                rules={rules.filter((r) => r.kind === k)}
                byId={byId}
                classOf={classOf}
                readOnly={!!workspace?.readOnly}
              />
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function NewRuleForm({ kind, students, preselect }: { kind: RuleKind; students: Student[]; preselect: number[] }) {
  const refresh = useWorkspace((s) => s.refresh);
  const [leader, setLeader] = useState<number | null>(kind === "one_to_many" ? (preselect[0] ?? null) : null);
  const [members, setMembers] = useState<number[]>(kind === "one_to_many" ? [] : preselect);
  const [reason, setReason] = useState("");
  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);

  const leaderMode = kind === "one_to_many";
  const all = [...(leader != null ? [leader] : []), ...members];
  const canSave = leaderMode ? leader != null && members.length >= 1 : members.length >= 2;

  const save = async () => {
    try {
      await api.createRule({
        kind,
        reason: reason.trim() || null,
        members: [
          ...(leaderMode && leader != null ? [{ studentId: leader, role: "leader" as const }] : []),
          ...members.map((id) => ({ studentId: id, role: "member" as const })),
        ],
      });
      await refresh();
      setLeader(null);
      setMembers([]);
      setReason("");
      toast.success(`${RULE_KIND_LABEL[kind]} 규칙을 만들었습니다.`);
    } catch (e) {
      toast.error("규칙을 만들지 못했습니다.", { description: errorMessage(e) });
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <h3 className="text-sm font-semibold">새 {RULE_KIND_LABEL[kind]} 규칙</h3>
      {leaderMode && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-xs text-muted-foreground">기준(A)</span>
          {leader != null ? (
            <StudentChip s={byId.get(leader)!} lead onRemove={() => setLeader(null)} />
          ) : (
            <div className="w-64">
              <StudentPicker
                students={students}
                exclude={all}
                onPick={(s) => setLeader(s.id)}
                placeholder="기준 학생 찾기"
              />
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {leaderMode && <span className="w-16 text-xs text-muted-foreground">나머지</span>}
        {members.map((id) => (
          <StudentChip key={id} s={byId.get(id)!} onRemove={() => setMembers(members.filter((x) => x !== id))} />
        ))}
        <div className="w-64">
          <StudentPicker students={students} exclude={all} onPick={(s) => setMembers([...members, s.id])} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          placeholder="사유(선택)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="h-8 flex-1"
        />
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          규칙 만들기
        </Button>
      </div>
    </div>
  );
}

function RuleList({
  rules,
  byId,
  classOf,
  readOnly,
}: {
  rules: Rule[];
  byId: Map<number, Student>;
  classOf: (id: number) => number | undefined;
  readOnly: boolean;
}) {
  const refresh = useWorkspace((s) => s.refresh);
  const sorted = useMemo(
    () =>
      [...rules].sort((a, b) => {
        const va = ruleViolations(a, classOf).length > 0 ? 0 : 1;
        const vb = ruleViolations(b, classOf).length > 0 ? 0 : 1;
        return va - vb || Number(b.enabled) - Number(a.enabled) || a.id - b.id;
      }),
    [rules, classOf],
  );

  const update = async (r: Rule, enabled: boolean, reason: string | null) => {
    try {
      await api.updateRule(r.id, enabled, reason);
      await refresh();
    } catch (e) {
      toast.error("규칙을 바꾸지 못했습니다.", { description: errorMessage(e) });
    }
  };
  const remove = async (r: Rule) => {
    try {
      await api.deleteRule(r.id);
      await refresh();
    } catch (e) {
      toast.error("규칙을 지우지 못했습니다.", { description: errorMessage(e) });
    }
  };

  if (sorted.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">규칙이 없습니다.</p>;

  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((r) => {
        const v = ruleViolations({ ...r, enabled: true }, classOf);
        const violated = r.enabled && v.length > 0;
        return (
          <li
            key={r.id}
            className={cn(
              "flex flex-col gap-2 rounded-lg border p-3",
              !r.enabled && "opacity-55",
              violated && "border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20",
            )}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {r.members.map((m) => {
                const s = byId.get(m.studentId);
                return s ? <StudentChip key={m.studentId} s={s} lead={m.role === "leader"} /> : null;
              })}
              {r.origin === "auto" && (
                <Badge variant="outline" className="ml-1 h-5 text-[10px]">
                  자동
                </Badge>
              )}
              {violated && (
                <Badge variant="destructive" className="h-5 gap-1 text-[10px]">
                  <AlertTriangle className="size-3" />
                  위반: {v.map((x) => `${x.cls}반`).join(", ")}
                </Badge>
              )}
              {!r.enabled && v.length > 0 && (
                <span className="text-xs text-muted-foreground">(꺼짐 — 같은 반 {v.map((x) => x.cls).join(", ")})</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={r.enabled}
                  disabled={readOnly}
                  onChange={(e) => void update(r, e.target.checked, r.reason)}
                />
                검사
              </label>
              <Input
                key={`${r.id}-${r.reason ?? ""}`}
                defaultValue={r.reason ?? ""}
                placeholder={r.enabled ? "사유(선택)" : "끈 사유(예: 학부모 같은 반 희망)"}
                disabled={readOnly}
                className="h-8 flex-1"
                onBlur={(e) => {
                  if ((e.target.value.trim() || null) !== r.reason)
                    void update(r, r.enabled, e.target.value.trim() || null);
                }}
              />
              {r.kind !== "same_name" && !readOnly && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  title="규칙 지우기"
                  onClick={() => void remove(r)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
