import { useEffect, useEffectEvent, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { subscribeToTauri } from "./tauriListener";

/**
 * 창에 파일을 끌어다 놓을 때 경로를 받는다(Tauri 드래그 앤 드롭 이벤트).
 * 지정한 확장자와 일치하는 첫 파일만 넘긴다.
 */
export function useFileDrop(extension: string, onDrop: (path: string) => void, enabled = true) {
  const [hovering, setHovering] = useState(false);
  const handleDrop = useEffectEvent((path: string) => onDrop(path));

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const suffix = `.${extension.toLowerCase()}`;
    const stop = subscribeToTauri<DragDropEvent>(
      (listener) => getCurrentWebview().onDragDropEvent(listener),
      ({ payload }) => {
        setHovering(payload.type === "enter" || payload.type === "over");
        if (payload.type === "drop") {
          const path = payload.paths.find((p) => p.toLowerCase().endsWith(suffix));
          if (path) handleDrop(path);
        }
      },
    );
    return () => {
      stop();
      setHovering(false);
    };
  }, [extension, enabled]);

  return enabled && hovering;
}
