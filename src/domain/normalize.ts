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

/**
 * 기준성적 글자를 100배 정수(0.01점 단위)로 바꾼다. 예: `1,073.89` → 107389, `382.3` → 38230.
 * 부동소수점을 거치지 않고 숫자 글자만으로 만들어 컴퓨터마다 결과가 달라지지 않는다.
 * 천 단위 쉼표를 허용하고, 소수 셋째 자리 이상이 있거나 해석할 수 없으면 null.
 */
export function toBaseScore(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const digits = m[2].replace(/,/g, "") + (m[3] ?? "").padEnd(2, "0");
  const v = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(v)) return null;
  return m[1] === "-" ? -v : v;
}

/** 성명에 로마자가 있는지(외국 국적 학생 감지). */
export function hasRomanLetters(s: string): boolean {
  return /[A-Za-z]/.test(s);
}
