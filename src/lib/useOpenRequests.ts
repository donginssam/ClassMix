import { useEffect } from "react";
import { api } from "@/lib/api";
import { openRequestedFile } from "@/lib/fileActions";

/**
 * 탐색기·Finder에서 .mix를 열었을 때(앱 시작 시 실행 인자, 이미 실행 중일 때 두 번째 실행,
 * macOS 열기 이벤트) Rust가 맡겨 둔 경로를 가져와 연다.
 * Rust는 경로를 보관하고 `open-file-requested` 이벤트만 보내므로, 화면이 늦게 떠도 놓치지 않는다.
 */
export function useOpenRequests(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let again = false;
    let unlisten: (() => void) | undefined;

    const take = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        // 처리하는 사이 새 요청이 오면 그것까지 이어서 연다.
        do {
          again = false;
          const path = await api.takeLaunchFile();
          if (path && !disposed) await openRequestedFile(path);
        } while (again && !disposed);
      } catch {
        // Tauri 밖(브라우저 미리보기)에서는 무시
      } finally {
        busy = false;
      }
    };

    import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const fn = await listen("open-file-requested", () => void take());
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    void take();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
}
