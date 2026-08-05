// packages/core/src/engine/format.ts
// 권고 문구에 박히는 숫자의 표시 형식. core가 문장을 만드는 이상 형식도 core가 책임진다.

/**
 * 정수를 3자리마다 쉼표로 끊는다.
 * `toLocaleString()`은 실행 환경 로케일에 따라 구분자가 달라지므로 쓰지 않는다.
 * 정규식으로 직접 끊어 어느 환경에서나 같은 문자열이 나오게 한다.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
