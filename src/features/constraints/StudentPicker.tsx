import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { nameKey } from "@/domain/normalize";
import type { Student } from "@/lib/api";

/** 동명이인을 구분하는 꼬리표가 붙은 학생 이름. 예) "바쿠 (이전 3-8, 남)" */
export function studentLabel(s: Student): string {
  if (!s.sameName) return s.nameNorm;
  const parts = [`이전 ${s.prevClass}-${s.prevNumber}`];
  if (s.gender) parts.push(s.gender);
  return `${s.nameNorm} (${parts.join(", ")})`;
}

/** 이름·한글 발음으로 찾아 고르는 자동완성 입력 */
export function StudentPicker({
  students,
  exclude,
  onPick,
  placeholder,
}: {
  students: Student[];
  exclude: number[];
  onPick: (s: Student) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const k = nameKey(q);
    if (!k) return [];
    return students
      .filter((s) => !exclude.includes(s.id))
      .filter((s) => nameKey(s.name).includes(k) || (s.sortName && nameKey(s.sortName).includes(k)))
      .slice(0, 8);
  }, [q, students, exclude]);

  return (
    <div className="relative">
      <Input
        value={q}
        placeholder={placeholder ?? "이름으로 찾기"}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && matches[0]) {
            e.preventDefault();
            onPick(matches[0]);
            setQ("");
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-sm shadow-md">
          {matches.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  onPick(s);
                  setQ("");
                }}
              >
                <span>{studentLabel(s)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {s.curClass}반 {s.curNumber}번
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StudentChip({ s, onRemove, lead }: { s: Student; onRemove?: () => void; lead?: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs " +
        (lead ? "border-primary bg-primary/10 font-medium" : "bg-muted")
      }
    >
      {studentLabel(s)}
      <span className="tabular-nums text-muted-foreground">{s.curClass}반</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded-full hover:bg-background" aria-label="빼기">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
