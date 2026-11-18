/** 보드 조작 실행: 변경 묶음을 만들고 적용한 뒤, 새로 생긴 분리 규칙 위반을 알린다. */
import { toast } from "sonner";
import {
  addGapBefore,
  editGapName,
  isEmptyChange,
  moveStudent,
  removeGap,
  renumberClasses,
  resetToOriginal,
  setNumber,
  setReadings,
  swapStudents,
  type BoardState,
} from "@/domain/changes";
import { allViolations, describeViolation, type Violation } from "@/domain/separation";
import type { ChangeSet } from "@/lib/api";
import { useWorkspace } from "@/store/workspace";
import { useBoardUi } from "./uiStore";

export function boardState(): BoardState {
  const s = useWorkspace.getState();
  return {
    students: s.students,
    gaps: s.gaps,
    classStates: s.classStates,
    classCount: s.workspace?.classCount ?? 0,
  };
}

function currentViolations(): Violation[] {
  const { students, rules } = useWorkspace.getState();
  const cls = new Map(students.map((s) => [s.id, s.curClass]));
  return allViolations(rules, (id) => cls.get(id));
}

const vKey = (v: Violation) => `${v.rule.id}:${v.cls}:${[...v.studentIds].sort().join(",")}`;

type Built = { ok: true; change: ChangeSet } | { ok: false; error: string };

/** 변경 묶음을 적용한다. 바뀐 학생을 강조하고, 새 위반이 생기면 토스트로 알린다(막지는 않음). */
export async function run(built: Built, opts?: { quiet?: boolean }): Promise<boolean> {
  if (!built.ok) {
    toast.error(built.error);
    return false;
  }
  if (isEmptyChange(built.change)) {
    if (!opts?.quiet) toast("바뀐 것이 없습니다.");
    return false;
  }
  const before = new Set(currentViolations().map(vKey));
  const ok = await useWorkspace.getState().applyChange(built.change);
  if (!ok) return false;
  const moved = built.change.students.filter((m) => m.from.c !== m.to.c).map((m) => m.studentId);
  useBoardUi.getState().setHighlight(moved);
  const { students } = useWorkspace.getState();
  const nameOf = (id: number) => students.find((s) => s.id === id)?.nameNorm ?? `#${id}`;
  const added = currentViolations().filter((v) => !before.has(vKey(v)));
  if (added.length) {
    toast.warning("분리 규칙 위반이 생겼습니다.", {
      description: added.map((v) => describeViolation(v, nameOf)).join("\n"),
      duration: 8000,
      action: { label: "되돌리기", onClick: () => void useWorkspace.getState().undo() },
    });
  }
  return true;
}

export const actions = {
  move: (studentId: number, toClass: number) => run(moveStudent(boardState(), studentId, toClass)),
  swap: (a: number, b: number) => run(swapStudents(boardState(), a, b)),
  renumber: (classes: number[]) => run(renumberClasses(boardState(), classes)),
  setNumber: (studentId: number, n: number) => run(setNumber(boardState(), studentId, n)),
  addGapBefore: (studentId: number) => run(addGapBefore(boardState(), studentId)),
  removeGap: (gapId: number) => run(removeGap(boardState(), gapId)),
  editGapName: (gapId: number, name: string | null) => run(editGapName(boardState(), gapId, name)),
  reset: () => run(resetToOriginal(boardState())),
  setReadings: async (readings: Map<number, string | null>) => {
    const r = setReadings(boardState(), readings);
    const ok = await run(r, { quiet: true });
    if (ok && r.ok && r.originalClasses?.length) {
      toast.info(
        `${r.originalClasses.sort((a, b) => a - b).join("·")}반은 나이스 번호 그대로라 번호를 바꾸지 않았습니다. 이 반을 재정렬하면 번호가 바뀝니다.`,
        { duration: 8000 },
      );
    }
    return ok;
  },
};
