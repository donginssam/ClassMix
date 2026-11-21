/**
 * 점수 표기. 점수는 모두 100을 곱한 정수(0.01점 단위)로 저장하고, 화면에 표시할 땐 1/100으로 환산하여 소수 둘째 자리까지 표시한다.
 * 부동소수점·Intl을 거치지 않고 정수 나눗셈과 글자 조립만으로 만들어 실행 환경에 따라 표기가 달라지지 않는다.
 */

/** 정수 나눗셈 몫·나머지(음수 없이 쓰는 값만 받는다). */
function divmod(a: number, b: number): [number, number] {
  const r = a % b;
  return [(a - r) / b, r];
}

/** 정수 a/b 를 반올림(0.5는 올림)한 정수. a ≥ 0, b > 0 인 정수만. */
export function roundDiv(a: number, b: number): number {
  const [q, r] = divmod(a, b);
  return r * 2 >= b ? q + 1 : q;
}

function group(intPart: number): string {
  return String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 100배 정수 점수를 `1,080.84` 처럼 쓴다. digits는 소수 자리 수(0~2)이며, 2보다 작으면 반올림한다.
 * 값이 없으면 "–".
 */
export function formatScore(score: number | null | undefined, digits: 0 | 1 | 2 = 2): string {
  if (score == null || !Number.isFinite(score)) return "–";
  const v = Math.round(score); // 이미 정수인 값만 들어온다(안전장치)
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const unit = 10 ** (2 - digits); // 2자리: 1, 1자리: 10, 0자리: 100
  const scaled = roundDiv(abs, unit); // 10^digits 배 정수
  const base = 10 ** digits;
  const [intPart, frac] = divmod(scaled, base);
  const fracText = digits > 0 ? "." + String(frac).padStart(digits, "0") : "";
  return `${sign}${group(intPart)}${fracText}`;
}

/** 부호를 붙인 점수 차(예: +1,024.50, -3.20). 100배 정수를 받는다. */
export function formatScoreDelta(score: number, digits: 0 | 1 | 2 = 2): string {
  return `${score >= 0 ? "+" : "-"}${formatScore(Math.abs(score), digits)}`;
}
