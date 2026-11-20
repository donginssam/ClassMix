/** 운영체제별 표시(단축키 기호 등). */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** 'Ctrl+O' / '⌘O' 처럼 수정 키를 붙인 단축키 표기 */
export function shortcut(key: string, opts: { shift?: boolean } = {}) {
  if (IS_MAC) return `${opts.shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${opts.shift ? "Shift+" : ""}${key}`;
}

export function isTypingTarget(t: Element | EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

/** 단축키 도움말을 여는 키: F1 또는 '?' */
export function isHelpKey(e: KeyboardEvent) {
  return e.key === "F1" || (e.key === "?" && !isTypingTarget(e.target));
}
