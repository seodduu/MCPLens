// packages/cli/src/args.ts
import type { ReportFormat } from './report.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const REPORT_FORMATS: ReportFormat[] = ['table', 'ai', 'json'];

/**
 * Validates `--days`. Same rule as the dashboard server.ts parseDays (finite, positive), but
 * the CLI reports bad input instead of silently falling back to the default, so a script
 * cannot receive a report for the wrong window because of a typo.
 */
export function parseDays(raw: string | undefined, fallback = 30): ParseResult<number> {
  if (raw === undefined) return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      message: `invalid --days value: "${raw}"\nPass a number greater than 0 (e.g. --days 30).`,
    };
  }
  return { ok: true, value: n };
}

/** Validates `--format`. An unknown value is never silently downgraded to table. */
export function parseFormat(raw: string | undefined): ParseResult<ReportFormat> {
  if (raw === undefined) return { ok: true, value: 'table' };
  if ((REPORT_FORMATS as string[]).includes(raw)) return { ok: true, value: raw as ReportFormat };
  return {
    ok: false,
    message: `invalid --format value: "${raw}"\nPass one of ${REPORT_FORMATS.join(', ')}.`,
  };
}
