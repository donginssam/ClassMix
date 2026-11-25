/**
 * 다시 읽은 보드 데이터에서, 내용이 같은 객체는 이전 객체를 그대로 쓴다(구조 공유).
 * 학생 한 명을 옮겨도 나머지 학생 객체와 목록의 참조가 유지되어, memo한 화면 조각이 다시 그려지지 않는다.
 */

/** 원시값만 비교하고, 배열·객체 값은 한 단계 더 들어가 같은지 본다(보드 DTO는 깊이가 얕다). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameValue(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameValue(ra[k], rb[k]));
}

/**
 * `next`의 각 항목을, 같은 키의 이전 항목과 내용이 같으면 이전 항목으로 바꾼다.
 * 모든 항목이 이전 것 그대로이고 순서도 같으면 이전 배열을 그대로 돌려준다.
 */
export function reuseList<T>(prev: readonly T[], next: T[], key: (item: T) => unknown): T[] {
  const byKey = new Map<unknown, T>();
  for (const p of prev) byKey.set(key(p), p);
  let changed = prev.length !== next.length;
  const out = next.map((item, i) => {
    const old = byKey.get(key(item));
    const kept = old !== undefined && sameValue(old, item) ? old : item;
    if (kept !== prev[i]) changed = true;
    return kept;
  });
  return changed ? out : (prev as T[]);
}
