import { useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** scripts/generate-third-party-licenses.mjs가 만드는 src/generated/third-party-licenses.json의 형태 */
interface LicenseData {
  app: { name: string; license: string; text: string } | null;
  sections: {
    id: string;
    title: string;
    packages: { name: string; version: string; license: string; texts: number[]; fallback?: boolean }[];
  }[];
  texts: string[];
}

/** 전문이 600KB가 넘어 처음 열 때만 불러온다(별도 청크). */
let cache: Promise<LicenseData> | null = null;
function loadLicenses(): Promise<LicenseData> {
  cache ??= import("@/generated/third-party-licenses.json").then((m) => m.default as LicenseData);
  return cache;
}

function LicenseRow({
  name,
  version,
  license,
  texts,
  note,
}: {
  name: string;
  version?: string;
  license: string;
  texts: string[];
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {version && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{version}</span>}
        <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-muted-foreground" title={license}>
          {license}
        </span>
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-2 px-3 pb-3 pl-8">
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {texts.map((t, i) => (
            <pre
              key={i}
              className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
            >
              {t}
            </pre>
          ))}
        </div>
      )}
    </li>
  );
}

function LicensesBody() {
  const [data, setData] = useState<LicenseData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    loadLicenses()
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const sections = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.sections.map((s) => ({
      ...s,
      total: s.packages.length,
      packages: q
        ? s.packages.filter((p) => p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q))
        : s.packages,
    }));
  }, [data, query]);

  if (failed) return <p className="text-sm text-destructive">라이선스 정보를 불러오지 못했습니다.</p>;
  if (!data) return <p className="text-sm text-muted-foreground">불러오는 중…</p>;

  const shown = sections.reduce((n, s) => n + s.packages.length, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름이나 라이선스로 찾기 (예: pdfjs, Apache)"
          aria-label="오픈소스 구성 요소 찾기"
          className="pl-8"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {data.app && !query && (
          <ul aria-label="ClassMix">
            <LicenseRow name={data.app.name} license={`${data.app.license} (이 프로그램)`} texts={[data.app.text]} />
          </ul>
        )}
        {sections.map(
          (s) =>
            s.packages.length > 0 && (
              <section key={s.id} aria-label={s.title}>
                <h3 className="sticky top-0 z-10 border-y bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                  {s.title} {query ? `${s.packages.length} / ${s.total}` : s.total}개
                </h3>
                <ul>
                  {s.packages.map((p) => (
                    <LicenseRow
                      key={`${p.name}@${p.version}`}
                      name={p.name}
                      version={p.version}
                      license={p.license}
                      texts={p.texts.map((i) => data.texts[i])}
                      note={
                        p.fallback
                          ? "패키지에 라이선스 파일이 없어, 표기된 라이선스의 표준 문구로 대신했습니다."
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </section>
            ),
        )}
        {query && shown === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">찾는 구성 요소가 없습니다.</p>
        )}
      </div>
    </div>
  );
}

export function LicensesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(80vh,720px)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>오픈소스 라이선스</DialogTitle>
          <DialogDescription className="break-keep">
            ClassMix는 MIT 라이선스로 배포되며, 아래 오픈소스 구성 요소를 포함합니다. 각 구성 요소는 해당 라이선스를
            따릅니다. 항목을 누르면 라이선스 전문을 볼 수 있습니다.
          </DialogDescription>
        </DialogHeader>
        {open && <LicensesBody />}
      </DialogContent>
    </Dialog>
  );
}
