/** 토큰 수를 상태바용 k-스케일 문자열로. 1000 미만은 원시값, 이상은 x.xk (floor). */
function formatK(tokens: number): string {
  return tokens >= 1000
    ? `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`
    : `${tokens}`;
}

export function formatStatus(wasteToolCount: number, wasteTokens: number): string {
  if (wasteToolCount === 0) return 'Lens: no waste ✓';
  return `Lens: ${wasteToolCount} wasteful tools · ${formatK(wasteTokens)}`;
}

export function wasteTooltip(wasteToolCount: number, wasteTokens: number): string {
  if (wasteToolCount === 0) return 'No wasteful tools found. Click for the detailed report.';
  return `${wasteToolCount} wasteful tools · ${formatK(wasteTokens)} tokens defined per session\n`
    + 'remove/filter-server verdicts, client attribution applied\n'
    + 'Click for the detailed report.';
}
