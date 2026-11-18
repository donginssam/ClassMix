/** 연속 공백·줄바꿈을 한 칸으로 줄이고 앞뒤 공백을 지운다. */
export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 성명 비교 키: 공백을 모두 지우고 대문자로. PDF 줄바꿈이나 띄어쓰기 차이,
 * 외국 국적 학생 로마자 이름의 대소문자 차이를 없앤다.
 */
export function nameKey(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

/** 정수로 읽는다. 비었거나 정수가 아니면 null. */
export function toInt(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/** `2007.11.19.` / `2007-11-19` → `2007-11-19`. 해석할 수 없으면 null. */
export function toIsoDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 소수 점수. 해석할 수 없으면 null. */
export function toScore(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** 성명에 로마자가 있는지(외국 국적 학생 감지). */
export function hasRomanLetters(s: string): boolean {
  return /[A-Za-z]/.test(s);
}
