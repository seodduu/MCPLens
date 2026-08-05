// packages/core/src/engine/format.ts
// Display format for the numbers embedded in recommendation text. core builds the sentences, so
// core owns the format too.

/**
 * Groups an integer with a comma every three digits.
 * `toLocaleString()` is avoided because its separator depends on the runtime locale.
 * Grouping with a regex directly yields the same string in every environment.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
