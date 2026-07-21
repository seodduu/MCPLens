/** 토큰 수를 상태바용 k-스케일 문자열로. 1000 미만은 원시값, 이상은 x.xk (floor). */
function formatK(tokens: number): string {
  return tokens >= 1000
    ? `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`
    : `${tokens}`;
}

export function formatStatus(wasteToolCount: number, wasteTokens: number): string {
  if (wasteToolCount === 0) return 'Lens: 낭비 없음 ✓';
  return `Lens: 낭비 ${wasteToolCount}툴 · ${formatK(wasteTokens)}`;
}

export function wasteTooltip(wasteToolCount: number, wasteTokens: number): string {
  if (wasteToolCount === 0) return '낭비로 판단한 툴 없음 · 클릭 → 상세 리포트';
  return `낭비로 판단한 툴 ${wasteToolCount}개 · 세션당 정의 ${formatK(wasteTokens)}토큰\n`
    + 'remove/filter-server 판정 · 클라이언트 귀속 적용\n'
    + '클릭 → 상세 리포트';
}
