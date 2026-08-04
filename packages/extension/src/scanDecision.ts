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
  /**
   * 정의 body가 적재돼 스캔이 실제로 완료된 서버명
   * (store.serversWithDefinitionBodies()). definition 존재만으로 판단하면
   * body 테이블 도입 이전 DB가 영원히 재스캔되지 않는다.
   */
  scannedServers: Set<string>;
  /** Lens가 지원하지 않는다고 판정한 서버명 — 스캔 시도조차 하지 않는다 */
  unsupported?: Set<string>;
}): ScanAction {
  const targets = args.specs.filter(
    (s) => !args.scannedServers.has(s.name) && !(args.unsupported?.has(s.name)));
  if (targets.length === 0 || args.setting === 'never') return { kind: 'skip' };
  if (args.setting === 'always') return { kind: 'scan', targets };
  return { kind: 'prompt', targets };
}
