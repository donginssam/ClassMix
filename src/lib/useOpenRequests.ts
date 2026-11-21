import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { openRequestedFile } from "@/lib/fileActions";
import { subscribeToTauri } from "./tauriListener";

/**
 * 탐색기·Finder에서 .mix를 열었을 때(앱 시작 시 실행 인자, 이미 실행 중일 때 두 번째 실행,
 * macOS 열기 이벤트) Rust가 맡겨 둔 경로를 가져와 연다.
 * Rust는 경로를 보관하고 `open-file-requested` 이벤트만 보내므로, 화면이 늦게 떠도 놓치지 않는다.
 */
export function useOpenRequests(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let disposed = false;
    let busy = false;
    let again = false;

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
      } catch (error) {
        console.warn("열기 요청을 처리하지 못했습니다.", error);
      } finally {
        busy = false;
      }
    };

    // 먼저 구독한 뒤 Rust가 보관해 둔 첫 요청을 가져온다.
    const request = () => void take();
    const stop = subscribeToTauri(
      (listener) =>
        listen("open-file-requested", listener).finally(() => {
          if (!disposed) request();
        }),
      request,
    );

    return () => {
      disposed = true;
      stop();
    };
  }, [enabled]);
}
