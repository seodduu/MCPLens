/** Token count as a k-scaled status bar string. Under 1000 stays raw; above it becomes x.xk (floored). */
function formatK(tokens: number): string {
  return tokens >= 1000
    ? `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`
    : `${tokens}`;
}

/** "1 tool"/"3 tools": singular/plural for the wasteful tool count. */
function toolWord(wasteToolCount: number): string {
  return wasteToolCount === 1 ? 'tool' : 'tools';
}

export function formatStatus(wasteToolCount: number, wasteTokens: number): string {
  if (wasteToolCount === 0) return 'Lens: no waste ✓';
  return `Lens: ${wasteToolCount} wasteful ${toolWord(wasteToolCount)} · ${formatK(wasteTokens)}`;
}

export function wasteTooltip(wasteToolCount: number, wasteTokens: number): string {
  if (wasteToolCount === 0) return 'No wasteful tools found. Click for the detailed report.';
  return `${wasteToolCount} wasteful ${toolWord(wasteToolCount)} · ${formatK(wasteTokens)} tokens defined per session\n`
    + 'remove/filter-server verdicts, client attribution applied\n'
    + 'Click for the detailed report.';
}
