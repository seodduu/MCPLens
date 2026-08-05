// packages/extension/src/reportCommand.ts
// The pure part of the showReport command (never import vscode).
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
