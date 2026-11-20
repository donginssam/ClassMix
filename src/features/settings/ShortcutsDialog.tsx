import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IS_MAC, shortcut } from "@/lib/platform";

interface Item {
  keys: string[];
  label: string;
}

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "파일",
    items: [
      { keys: [shortcut("N")], label: "새 반편성 만들기 (시작 화면)" },
      { keys: [shortcut("O")], label: "파일 열기" },
      { keys: [shortcut("S", { shift: true })], label: "다른 이름으로 저장" },
      { keys: [shortcut("E")], label: "나이스 업로드용 XLSX 내보내기" },
    ],
  },
  {
    title: "반편성",
    items: [
      { keys: [shortcut("Z")], label: "되돌리기" },
      { keys: IS_MAC ? [shortcut("Z", { shift: true })] : ["Ctrl+Y", "Ctrl+Shift+Z"], label: "다시 실행" },
      { keys: [shortcut("F")], label: "이름 찾기 (Enter: 다음 결과)" },
      { keys: ["Esc"], label: "선택·강조 해제" },
      { keys: ["끌어다 놓기"], label: "다른 반 학생 위: 바꾸기 · 반 빈 곳: 이동" },
    ],
  },
  {
    title: "도움말",
    items: [{ keys: ["F1", "?"], label: "이 단축키 목록" }],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>단축키</DialogTitle>
          <DialogDescription>입력칸에 글자를 쓰는 중에는 되돌리기 키가 글자 되돌리기로 동작합니다.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">{g.title}</h3>
              <ul className="flex flex-col divide-y rounded-lg border">
                {g.items.map((it) => (
                  <li key={it.label} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                    <span>{it.label}</span>
                    <span className="flex shrink-0 gap-1">
                      {it.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs whitespace-nowrap text-muted-foreground"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
