// packages/cli/src/args.ts
import type { ReportFormat } from './report.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const REPORT_FORMATS: ReportFormat[] = ['table', 'ai', 'json'];

/**
 * `--days` 값을 검증한다. 대시보드 server.ts의 parseDays와 같은 기준(유한한 양수)이지만,
 * CLI는 조용히 기본값으로 되돌리는 대신 잘못된 입력을 알린다. 스크립트가 오타를 눈치채지
 * 못한 채 엉뚱한 기간의 리포트를 받는 일을 막기 위해서다.
 */
export function parseDays(raw: string | undefined, fallback = 30): ParseResult<number> {
  if (raw === undefined) return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      message: `--days 값이 잘못되었습니다: "${raw}"\n0보다 큰 숫자를 지정하세요 (예: --days 30).`,
    };
  }
  return { ok: true, value: n };
}

/** `--format` 값을 검증한다. 알 수 없는 값을 table로 조용히 폴백하지 않는다. */
export function parseFormat(raw: string | undefined): ParseResult<ReportFormat> {
  if (raw === undefined) return { ok: true, value: 'table' };
  if ((REPORT_FORMATS as string[]).includes(raw)) return { ok: true, value: raw as ReportFormat };
  return {
    ok: false,
    message: `--format 값이 잘못되었습니다: "${raw}"\n${REPORT_FORMATS.join(', ')} 중 하나를 지정하세요.`,
  };
}
