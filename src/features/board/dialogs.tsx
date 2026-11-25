import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setNumberPreview } from "@/domain/changes";
import { hasRomanLetters } from "@/domain/normalize";
import { cleanReading, isHangulOnly, MAX_STUDENT_NUMBER } from "@/domain/numbering";
import { api, errorMessage, type Gap, type Student } from "@/lib/api";
import { useWorkspace } from "@/store/workspace";
import { actions, boardState } from "./actions";
import { useBoardUi } from "./uiStore";

/** 보드의 작은 편집 대화상자들을 한곳에서 띄운다. */
export function BoardDialogs() {
  const dialog = useBoardUi((s) => s.dialog);
  const close = useBoardUi((s) => s.closeDialog);
  return (
    <>
      <NumberDialog studentId={dialog?.kind === "number" ? dialog.studentId : null} onClose={close} />
      <GapNameDialog gapId={dialog?.kind === "gapName" ? dialog.gapId : null} onClose={close} />
      <MemoDialog studentId={dialog?.kind === "memo" ? dialog.studentId : null} onClose={close} />
      <ReadingDialog target={dialog?.kind === "reading" ? dialog.studentIds : null} onClose={close} />
      <ResetDialog open={dialog?.kind === "reset"} onClose={close} />
    </>
  );
}

// 각 대화상자는 바깥(대상 찾기) + 안쪽(key로 다시 마운트해 초기값 설정) 두 단계로 나눈다.

function NumberDialog({ studentId, onClose }: { studentId: number | null; onClose: () => void }) {
  const student = useWorkspace((s) => (studentId == null ? undefined : s.studentsById.get(studentId)));
  return student ? <NumberDialogBody key={student.id} student={student} onClose={onClose} /> : null;
}

function NumberDialogBody({ student, onClose }: { student: Student; onClose: () => void }) {
  const [value, setValue] = useState(String(student.curNumber));
  const n = Number(value);
  // 상한을 넘는 값은 미리 보기(오류 문구)만 보여 주고 적용하지 않는다.
  const valid = /^\d{1,9}$/.test(value.trim()) && n >= 1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const preview = useMemo(() => (valid ? setNumberPreview(boardState(), student.id, n) : null), [student, value]);

  const submit = async () => {
    if (!valid || n > MAX_STUDENT_NUMBER) return;
    if (await actions.setNumber(student.id, n)) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>번호 직접 수정</DialogTitle>
          <DialogDescription className="grid gap-1">
            <span className="font-medium text-foreground">
              {student.curClass}반 {student.curNumber}번 {student.nameNorm}
            </span>
            <span>번호를 늘리면 앞에 빈 번호가 생기고, 뒤 학생들이 밀립니다.</span>
            <span>번호를 줄이면 바로 앞의 빈 번호를 지워서 당깁니다.</span>
            <span>어느 쪽이든 학생 순서는 바뀌지 않습니다.</span>
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center gap-2">
            <Label htmlFor="num">새 번호</Label>
            <Input
              id="num"
              autoFocus
              inputMode="numeric"
              maxLength={9}
              className="w-24 tabular-nums"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          {preview && <p className="rounded-md bg-muted px-3 py-2 text-sm">{preview}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button type="submit" disabled={!valid || n > MAX_STUDENT_NUMBER || n === student.curNumber}>
              적용
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GapNameDialog({ gapId, onClose }: { gapId: number | null; onClose: () => void }) {
  const gap = useWorkspace((s) => s.gaps.find((g) => g.id === gapId));
  return gap ? <GapNameDialogBody key={gap.id} gap={gap} onClose={onClose} /> : null;
}

function GapNameDialogBody({ gap, onClose }: { gap: Gap; onClose: () => void }) {
  const sorted = useWorkspace((s) => s.classStates.find((c) => c.class === gap.class)?.numbering === "sorted");
  const [value, setValue] = useState(gap.plannedName ?? "");

  const submit = async () => {
    if (await actions.editGapName(gap.id, value.trim() || null)) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {gap.class}반 {gap.number}번 빈 번호 — 전입 예정 학생
          </DialogTitle>
          <DialogDescription className="grid gap-1">
            <span>이름을 적으면 그 이름의 가나다 위치에 빈 번호가 놓입니다.</span>
            <span>로마자 성명인 외국인 학생이면 성-이름 순서의 한글 표기를 적어 주세요.</span>
            {!sorted && <span>이 반은 나이스 번호 그대로라, 반을 재정렬할 때 위치가 반영됩니다.</span>}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            placeholder="예) 홍길동 (비우면 이름 없음)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button type="submit">저장</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemoDialog({ studentId, onClose }: { studentId: number | null; onClose: () => void }) {
  const student = useWorkspace((s) => (studentId == null ? undefined : s.studentsById.get(studentId)));
  return student ? <MemoDialogBody key={student.id} student={student} onClose={onClose} /> : null;
}

function MemoDialogBody({ student, onClose }: { student: Student; onClose: () => void }) {
  const refresh = useWorkspace((s) => s.refresh);
  const [value, setValue] = useState(student.memo ?? "");

  const submit = async () => {
    try {
      await api.setMemo(student.id, value.trim() || null);
      await refresh();
      onClose();
    } catch (e) {
      toast.error("메모를 저장하지 못했습니다.", { description: errorMessage(e) });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>메모 — {student.nameNorm}</DialogTitle>
          <DialogDescription className="grid gap-1">
            <span>메모는 작업 파일에만 저장됩니다.</span>
            <span>나이스 업로드 파일에는 들어가지 않습니다.</span>
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          rows={4}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => void submit()}>저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 로마자 성명 학생의 정렬용 한글 표기 입력(한 명 또는 전체 표) */
function ReadingDialog({ target, onClose }: { target: number[] | "all" | null; onClose: () => void }) {
  return target ? (
    <ReadingDialogBody key={target === "all" ? "all" : target.join(",")} target={target} onClose={onClose} />
  ) : null;
}

function ReadingDialogBody({ target, onClose }: { target: number[] | "all"; onClose: () => void }) {
  const students = useWorkspace((s) => s.students);
  const rows = useMemo(() => {
    const romans = students.filter((s) => hasRomanLetters(s.name));
    const list = target === "all" ? romans : romans.filter((s) => target.includes(s.id));
    return [...list].sort((a, b) => a.curClass - b.curClass || a.curNumber - b.curNumber);
  }, [students, target]);
  const [values, setValues] = useState<Map<number, string>>(() => new Map(rows.map((s) => [s.id, s.sortName ?? ""])));

  const invalid = [...values].filter(([, v]) => {
    const c = cleanReading(v);
    return c != null && !isHangulOnly(c);
  });

  const submit = async () => {
    const changes = new Map<number, string | null>();
    for (const s of rows) {
      const v = cleanReading(values.get(s.id));
      if (v !== cleanReading(s.sortName)) changes.set(s.id, v);
    }
    if (changes.size === 0) {
      onClose();
      return;
    }
    if (await actions.setReadings(changes)) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>로마자 성명 한글 표기</DialogTitle>
          <DialogDescription className="grid gap-1">
            <span>외국인등록증의 로마자 표기를 성명으로 고른 학생입니다.</span>
            <span>
              원지음(原地音)과 외래어 표기법에 맞춰 성-이름 순서로 한글 표기를 적으면, 번호를 매길 때 그 가나다 자리에
              들어갑니다.
            </span>
            <span>공백은 저장할 때 지우고, 나이스로 내보내는 성명은 로마자 그대로입니다.</span>
            <span>지금 건너뛰고 나중에 학생 메뉴에서 넣어도 됩니다.</span>
          </DialogDescription>
        </DialogHeader>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">로마자 성명 학생이 없습니다.</p>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-normal">성명</th>
                  <th className="w-20 py-1.5 text-center font-normal">반·번호</th>
                  <th className="w-48 px-3 py-1.5 text-left font-normal">한글 표기</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const v = values.get(s.id) ?? "";
                  const bad = cleanReading(v) != null && !isHangulOnly(cleanReading(v)!);
                  return (
                    <tr key={s.id} className="border-t">
                      <td className="px-3 py-1.5">{s.nameNorm}</td>
                      <td className="py-1.5 text-center tabular-nums text-muted-foreground">
                        {s.curClass}-{s.curNumber}
                      </td>
                      <td className="px-3 py-1">
                        <Input
                          autoFocus={i === 0}
                          value={v}
                          aria-invalid={bad}
                          placeholder="예) 팜하니"
                          onChange={(e) => setValues(new Map(values).set(s.id, e.target.value))}
                          className="h-8"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {invalid.length > 0 && <p className="text-sm text-destructive">한글(완성형)만 입력할 수 있습니다.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {target === "all" ? "나중에 입력" : "취소"}
          </Button>
          <Button onClick={() => void submit()} disabled={invalid.length > 0 || rows.length === 0}>
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>나이스 기본 편성으로 되돌릴까요?</AlertDialogTitle>
          <AlertDialogDescription className="grid gap-1">
            <span>모든 학생을 나이스에서 받은 반·번호로 되돌립니다.</span>
            <span>직접 만든 빈 번호는 지웁니다.</span>
            <span>한글 표기·메모·분리 규칙은 그대로 둡니다.</span>
            <span>이 작업도 [되돌리기]로 취소할 수 있습니다.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onClose();
              void actions.reset();
            }}
          >
            되돌리기
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
