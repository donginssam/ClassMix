import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** 맥 앱 창: 제목 표시줄을 숨기고 신호등 버튼을 앱 화면 위에 겹친다(tauri.macos.conf.json). */
export const HAS_MAC_CHROME = IS_MAC && isTauri();

/**
 * 화면 맨 위 막대이자 창의 제목 표시줄. 높이 52px, 신호등 버튼은 이 막대의 세로 가운데에 놓인다.
 * 빈 곳을 끌면 창이 움직이고, 두 번 클릭하면 창이 커진다. 안의 글자도 끌 수 있게 하려면 `dragRegion`을 붙인다.
 */
export function TitleBar({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header
      {...dragRegion}
      className={cn("flex h-13 shrink-0 items-center gap-2 pr-3 pl-(--traffic-inset) select-none", className)}
    >
      {children}
    </header>
  );
}

/**
 * 이 속성이 붙은 요소를 끌면 창이 움직인다(자식 요소에는 따로 붙여야 한다).
 * 맥 앱 창에서만 붙인다. 다른 OS는 자체 제목 표시줄로 창을 움직일 수 있고, 창 드래그 권한도
 * 맥에만 주므로(capabilities/macos-titlebar.json) 붙이면 "start_dragging not allowed by ACL" 오류가 난다.
 */
export const dragRegion: { "data-tauri-drag-region"?: true } = HAS_MAC_CHROME ? { "data-tauri-drag-region": true } : {};
