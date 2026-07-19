// packages/extension/src/scanDecision.ts — vscode import 금지
import type { McpServerSpec } from '@mcp-lens/core';

export type AutoScanSetting = 'prompt' | 'always' | 'never';

export type ScanAction =
  | { kind: 'skip' }
  | { kind: 'prompt'; targets: McpServerSpec[] }
  | { kind: 'scan'; targets: McpServerSpec[] };

export function decideScanAction(args: {
  setting: AutoScanSetting;
  specs: McpServerSpec[];
  /** 이미 정의가 DB에 있는 서버명 (store.allDefinitions()에서 추출) */
  knownServers: Set<string>;
}): ScanAction {
  const targets = args.specs.filter((s) => !args.knownServers.has(s.name));
  if (targets.length === 0 || args.setting === 'never') return { kind: 'skip' };
  if (args.setting === 'always') return { kind: 'scan', targets };
  return { kind: 'prompt', targets };
}
