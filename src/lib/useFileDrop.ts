import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * 창에 파일을 끌어다 놓을 때 경로를 받는다(Tauri 드래그 앤 드롭 이벤트).
 * `extensions`에 맞는 첫 파일만 넘긴다.
 */
export function useFileDrop(extensions: string[], onDrop: (path: string) => void, enabled = true) {
  const [hovering, setHovering] = useState(false);
  const handler = useRef(onDrop);
  useEffect(() => {
    handler.current = onDrop;
  }, [onDrop]);
  const exts = extensions.map((e) => e.toLowerCase()).join(",");

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const allowed = exts.split(",");
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setHovering(true);
        else if (p.type === "leave") setHovering(false);
        else if (p.type === "drop") {
          setHovering(false);
          const path = p.paths.find((x) => allowed.some((e) => x.toLowerCase().endsWith(`.${e}`)));
          if (path) handler.current(path);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Tauri 밖(브라우저)에서는 무시
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [exts, enabled]);

  return hovering;
}
