import { useState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { dragRegion, TitleBar } from "@/app/TitleBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { closeWorkFile } from "@/lib/fileActions";
import { useWorkspace } from "@/store/workspace";

/** 암호가 걸린 작업 파일을 열 때 비밀번호를 받는다. */
export function UnlockScreen() {
  const workspace = useWorkspace((s) => s.workspace)!;
  const setWorkspace = useWorkspace((s) => s.setWorkspace);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.unlockWorkFile(password);
      setPassword("");
      await setWorkspace(ws);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-board">
      <TitleBar className="justify-between">
        <h1 {...dragRegion} className="truncate text-sm leading-5 font-semibold">
          {workspace.fileName}
        </h1>
        <Button variant="ghost" onClick={closeWorkFile}>
          닫기
        </Button>
      </TitleBar>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <LockKeyhole className="size-9 text-muted-foreground" />
          <h2 className="text-base font-semibold">암호가 걸린 반편성 파일</h2>
          <p className="text-sm text-muted-foreground">비밀번호를 입력하면 이 파일을 닫을 때까지 열어 둡니다.</p>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unlock-password">비밀번호</Label>
            <Input
              id="unlock-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              aria-invalid={error != null}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <Button type="submit" disabled={!password || busy}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {busy ? "확인하는 중…" : "열기"}
          </Button>
        </form>
      </main>
    </div>
  );
}
