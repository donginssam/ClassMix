import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { CircleCheck, CircleAlert, Link2, Link2Off, Monitor, Moon, Scale, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage, type AssociationStatus } from "@/lib/api";
import { appDescription } from "@/lib/brand";
import { LicensesDialog } from "./LicensesDialog";

const appearances = [
  { value: "system", label: "시스템 설정", Icon: Monitor },
  { value: "light", label: "라이트", Icon: Sun },
  { value: "dark", label: "다크", Icon: Moon },
] as const;

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <fieldset className="min-w-0 border-b pb-4">
      <legend className="mb-2 text-sm font-semibold">화면 모드</legend>
      <div className="grid grid-cols-3 gap-1 rounded-lg border bg-muted p-1">
        {appearances.map(({ value, label, Icon }) => (
          <label key={value} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name="appearance"
              value={value}
              checked={(theme ?? "system") === value}
              onChange={() => setTheme(value)}
              className="peer sr-only"
            />
            <span className="flex items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground hover:text-foreground peer-checked:border-border peer-checked:bg-background peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              {label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** `.mix` 파일 연결 상태를 읽는다. Tauri 밖이면 null. */
export function useAssociationStatus() {
  const [status, setStatus] = useState<AssociationStatus | null>(null);
  const reload = useCallback(() => {
    api
      .fileAssociationStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(reload, [reload]);
  return { status, setStatus, reload };
}

export async function registerAssociation(): Promise<AssociationStatus | null> {
  try {
    const s = await api.registerFileAssociation();
    toast.success(".mix 파일을 ClassMix로 열도록 등록했습니다.", {
      description: "이제 탐색기에서 .mix 파일을 두 번 클릭하면 열립니다.",
    });
    return s;
  } catch (e) {
    toast.error("파일 연결을 등록하지 못했습니다.", { description: errorMessage(e) });
    return null;
  }
}

function AssociationSection() {
  const { status, setStatus } = useAssociationStatus();
  const [busy, setBusy] = useState(false);
  if (!status || status.state === "unsupported") return null;

  const run = async (fn: () => Promise<AssociationStatus | null>) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) setStatus(s);
    } finally {
      setBusy(false);
    }
  };
  const unregister = async () => {
    try {
      const s = await api.unregisterFileAssociation();
      toast.success(".mix 파일 연결을 해제했습니다.");
      return s;
    } catch (e) {
      toast.error("파일 연결을 해제하지 못했습니다.", { description: errorMessage(e) });
      return null;
    }
  };

  return (
    <section className="flex flex-col gap-2 border-b pb-4">
      <h3 className="text-sm font-semibold">.mix 파일을 ClassMix로 열기</h3>
      {status.state === "current" && (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
          <span className="grid gap-0.5">
            <span>등록되어 있습니다.</span>
            <span>탐색기에서 .mix 파일을 두 번 클릭하면 이 ClassMix로 열립니다.</span>
          </span>
        </p>
      )}
      {status.state === "none" && (
        <p className="grid gap-0.5 text-sm text-muted-foreground">
          <span>설치 과정이 없는 프로그램이라 자동으로 연결되지 않습니다.</span>
          <span>등록하면 탐색기에서 .mix 파일을 두 번 클릭해 열 수 있습니다.</span>
          <span>관리자 권한은 필요 없고, 지금 Windows 사용자에게만 적용됩니다.</span>
        </p>
      )}
      {status.state === "moved" && (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            다른 위치의 ClassMix로 등록되어 있습니다(실행 파일을 옮겼거나 다른 사본).
            <span className="mt-0.5 block truncate text-xs" title={status.registeredExe ?? ""}>
              등록된 위치: {status.registeredExe}
            </span>
          </span>
        </p>
      )}
      <div className="flex gap-2">
        {status.state !== "current" && (
          <Button size="sm" disabled={busy} onClick={() => run(registerAssociation)}>
            <Link2 data-icon="inline-start" />
            {status.state === "moved" ? "이 위치로 다시 등록" : "등록"}
          </Button>
        )}
        {status.state !== "none" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(unregister)}>
            <Link2Off data-icon="inline-start" />
            연결 해제
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        등록해도 열리지 않으면 .mix 파일을 오른쪽 클릭 → [연결 프로그램] → [다른 앱 선택]에서 ClassMix를 고르세요.
      </p>
    </section>
  );
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [licensesOpen, setLicensesOpen] = useState(false);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);
  return (
    <section className="flex flex-col gap-2 text-sm">
      <h3 className="font-semibold">정보</h3>
      <p>
        <span className="font-medium">ClassMix</span>
        {version && <span className="ml-1.5 tabular-nums text-muted-foreground">버전 {version}</span>}
        <span className="block text-muted-foreground">{appDescription}</span>
      </p>
      <ul className="list-disc space-y-1 pl-5 text-xs break-keep text-muted-foreground">
        <li>학생 정보는 .mix 작업 파일 안에만 저장되며, 인터넷으로 보내지 않습니다.</li>
        <li>자동 업데이트는 없습니다. 새 버전은 실행 파일만 바꿔 쓰면 되고 .mix 파일은 그대로 쓸 수 있습니다.</li>
        <li>글꼴: IBM Plex Sans KR — Copyright © IBM Corp., SIL Open Font License 1.1에 따라 포함·재배포합니다.</li>
      </ul>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <span className="grid gap-0.5">
          <span className="font-medium">오픈소스 라이선스</span>
          <span className="text-xs text-muted-foreground">MIT 라이선스 · 포함된 구성 요소와 라이선스 전문</span>
        </span>
        <Button size="sm" variant="outline" onClick={() => setLicensesOpen(true)}>
          <Scale data-icon="inline-start" />
          보기
        </Button>
      </div>
      <LicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />
    </section>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>설정 및 정보</DialogTitle>
          <DialogDescription className="grid gap-1">
            <span>이 PC에서만 적용되는 설정입니다.</span>
            <span>작업 파일(.mix)에는 저장되지 않습니다.</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <AppearanceSection />
          <AssociationSection />
          <AboutSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
