// packages/extension/src/reportCommand.ts
// showReport 커맨드의 순수 부분 — vscode import 금지.
import type { ReportOptions } from '@mcp-lens/core';

export interface ReportConfig {
  reportDays: number;
  reportDetail?: 'summary' | 'full';
}

export function reportOptions(config: ReportConfig): ReportOptions {
  return {
    detail: config.reportDetail ?? 'summary',
    days: Math.max(1, config.reportDays),
  };
}
