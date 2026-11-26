import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import type { EncryptionMode } from "@/features/board/uiStore";
import { api, errorCode, errorMessage, type WorkspaceInfo } from "@/lib/api";
import { closeWorkFile } from "@/lib/fileActions";
import { useWorkspace } from "@/store/workspace";

/** Rust `crypto::MIN_PASSWORD_LEN`과 같은 값 */
const MIN_LEN = 8;

/**
 * 작업 파일 암호 설정·해제·변경. 모든 대상 자료를 한꺼번에 암·복호화(변경은 새 키로 다시 암호화)한다.
 * 어떤 대화상자인지는 열 때 정한 `mode`를 따른다. 현재 암호 상태를 보고 대화상자를 고르면, 처리가 끝나
 * 상태가 바뀌는 순간 닫히기 전에 반대쪽 대화상자(설정↔해제)가 잠깐 보일 수 있다.
 */
export function EncryptionDialog({ mode, onClose }: { mode: EncryptionMode | null; onClose: () => void }) {
  return (
    <Dialog open={mode != null} onOpenChange={(o) => !o && onClose()}>
      {mode === "enable" && <EnableBody onDone={onClose} />}
      {mode === "disable" && <DisableBody onDone={onClose} />}
      {mode === "change" && <ChangeBody onDone={onClose} />}
    </Dialog>
  );
}

/** success: [알림 제목, 덧붙일 설명] */
function useSubmit(action: () => Promise<WorkspaceInfo>, success: [string, string?], onDone: () => void) {
  const setWorkspace = useWorkspace((s) => s.setWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    let ws: WorkspaceInfo;
    try {
      ws = await action();
    } catch (e) {
      if (errorCode(e) === "file_closed") {
        // 처리 도중 작업 파일이 닫혔다. 대화상자와 편성표 화면을 정리하고 다시 열도록 안내한다.
        setBusy(false);
        onDone();
        toast.error("작업 파일을 닫았습니다.", { description: errorMessage(e) });
        await closeWorkFile();
        return;
      }
      // 비밀번호가 틀린 경우 등: 대화상자에 그대로 보여 준다.
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    // 처리는 끝났다. 대화상자를 먼저 닫고 화면을 새로 읽는다.
    onDone();
    try {
      await setWorkspace(ws);
      toast.success(success[0], { description: success[1] });
    } catch (e) {
      toast.error("화면을 새로 고치지 못했습니다.", { description: errorMessage(e) });
    }
  };
  return { busy, error, run };
}

function EnableBody({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [understood, setUnderstood] = useState(false);
  const { busy, error, run } = useSubmit(
    () => api.enableEncryption(pw),
    ["작업 파일에 암호를 설정했습니다.", "다음에 열 때 비밀번호를 묻습니다."],
    onDone,
  );
  const tooShort = pw.length > 0 && [...pw].length < MIN_LEN;
  const blank = pw.length > 0 && pw.trim() === "";
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ok = [...pw].length >= MIN_LEN && !blank && pw === pw2 && understood;

  return (
    <DialogContent className="sm:max-w-md" onInteractOutside={(e) => busy && e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>작업 파일에 암호 설정하기</DialogTitle>
        <DialogDescription className="grid gap-1">
          <span>아래 자료를 비밀번호로 암호화합니다.</span>
          <span className="text-foreground">
            이름 · 진급반번호 · 생년월일 · 기준성적 · 메모 · 변경 이력 · 분리 규칙 사유
          </span>
          <span>현재·원래 반과 번호, 성별, 원본 파일 이름은 평문으로 저장됩니다.</span>
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) void run();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="enc-pw">비밀번호({MIN_LEN}자 이상)</Label>
          <Input
            id="enc-pw"
            type="password"
            autoFocus
            autoComplete="new-password"
            value={pw}
            aria-invalid={tooShort || blank}
            onChange={(e) => setPw(e.target.value)}
          />
          {tooShort && <p className="text-xs text-destructive">{MIN_LEN}자 이상 입력해 주세요.</p>}
          {blank && <p className="text-xs text-destructive">공백만으로 된 비밀번호는 쓸 수 없습니다.</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="enc-pw2">비밀번호 확인</Label>
          <Input
            id="enc-pw2"
            type="password"
            autoComplete="new-password"
            value={pw2}
            aria-invalid={mismatch}
            onChange={(e) => setPw2(e.target.value)}
          />
          {mismatch && <p className="text-xs text-destructive">비밀번호가 서로 다릅니다.</p>}
        </div>
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>
            비밀번호를 잊으면 이 파일을 <b>다시 열 수 없다</b>는 점을 이해했습니다.
          </span>
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
            취소
          </Button>
          <Button type="submit" disabled={!ok || busy}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {busy ? "암호화하는 중…" : "암호 설정"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function DisableBody({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const { busy, error, run } = useSubmit(() => api.disableEncryption(pw), ["작업 파일의 암호를 해제했습니다."], onDone);
  return (
    <DialogContent className="sm:max-w-md" onInteractOutside={(e) => busy && e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>작업 파일 암호 해제하기</DialogTitle>
        <DialogDescription className="grid gap-1">
          <span>비밀번호 보호를 풀고, 암호화하지 않은 상태로 저장합니다.</span>
          <span>이제부터는 비밀번호 없이 파일을 열 수 있습니다.</span>
          <span>확인하려면 현재 비밀번호를 입력해 주세요.</span>
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw && !busy) void run();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="dec-pw">현재 비밀번호</Label>
          <Input
            id="dec-pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={pw}
            aria-invalid={error != null}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
            취소
          </Button>
          <Button type="submit" variant="destructive" disabled={!pw || busy}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {busy ? "해제하는 중…" : "암호 해제"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ChangeBody({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { busy, error, run } = useSubmit(
    () => api.changePassword(current, pw),
    ["비밀번호를 바꿨습니다.", "다음에 열 때부터 새 비밀번호를 씁니다."],
    onDone,
  );
  const tooShort = pw.length > 0 && [...pw].length < MIN_LEN;
  const blank = pw.length > 0 && pw.trim() === "";
  const mismatch = pw2.length > 0 && pw !== pw2;
  const same = pw.length > 0 && pw === current;
  const ok = current.length > 0 && [...pw].length >= MIN_LEN && !blank && pw === pw2 && !same;

  return (
    <DialogContent className="sm:max-w-md" onInteractOutside={(e) => busy && e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>작업 파일 암호 변경하기</DialogTitle>
        <DialogDescription className="grid gap-1">
          <span>현재 비밀번호를 확인한 뒤, 보호된 자료를 새 비밀번호로 다시 암호화합니다.</span>
          <span>새 비밀번호도 잊으면 파일을 다시 열 수 없습니다.</span>
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) void run();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chg-current">현재 비밀번호</Label>
          <Input
            id="chg-current"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chg-pw">새 비밀번호({MIN_LEN}자 이상)</Label>
          <Input
            id="chg-pw"
            type="password"
            autoComplete="new-password"
            value={pw}
            aria-invalid={tooShort || blank || same}
            onChange={(e) => setPw(e.target.value)}
          />
          {tooShort && <p className="text-xs text-destructive">{MIN_LEN}자 이상 입력해 주세요.</p>}
          {blank && <p className="text-xs text-destructive">공백만으로 된 비밀번호는 쓸 수 없습니다.</p>}
          {same && <p className="text-xs text-destructive">현재 비밀번호와 다른 비밀번호를 입력해 주세요.</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chg-pw2">새 비밀번호 확인</Label>
          <Input
            id="chg-pw2"
            type="password"
            autoComplete="new-password"
            value={pw2}
            aria-invalid={mismatch}
            onChange={(e) => setPw2(e.target.value)}
          />
          {mismatch && <p className="text-xs text-destructive">비밀번호가 서로 다릅니다.</p>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
            취소
          </Button>
          <Button type="submit" disabled={!ok || busy}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {busy ? "바꾸는 중…" : "암호 변경"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
