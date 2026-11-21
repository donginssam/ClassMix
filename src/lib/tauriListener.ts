import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

/** 구독 등록이 끝나기 전에 화면을 닫아도 리스너를 해제한다. */
export function subscribeToTauri<T>(
  register: (listener: EventCallback<T>) => Promise<UnlistenFn>,
  listener: EventCallback<T>,
) {
  let active = true;
  let unlisten: UnlistenFn | undefined;

  register((event) => {
    if (active) listener(event);
  })
    .then((stop) => {
      if (!active) {
        stop();
        return;
      }
      unlisten = stop;
    })
    .catch((error) => console.warn("Tauri 이벤트 구독에 실패했습니다.", error));

  return () => {
    active = false;
    unlisten?.();
  };
}
