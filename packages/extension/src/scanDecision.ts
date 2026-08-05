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
  /**
   * 이 DB로 아직 한 번도 스캔한 적이 없다(정의가 0건). 설치 직후의 첫 실행이다.
   * body 유무가 아니라 정의 유무로 본다. body 테이블 도입 이전 DB는 정의는 있고
   * body만 없으므로, body로 판정하면 그 사용자의 재스캔까지 첫 실행으로 오인한다.
   */
  neverScanned?: boolean;
}): ScanAction {
  const targets = args.specs.filter(
    (s) => !args.scannedServers.has(s.name) && !(args.unsupported?.has(s.name)));
  if (targets.length === 0 || args.setting === 'never') return { kind: 'skip' };
  // 첫 실행에는 확장이 나서지 않는다. 온보딩 워크스루가 스캔·훅·분석·전역 조치를
  // 사용자가 직접 밟도록 안내하고, 분석에 쓸 LLM 제공자 선택도 그 안에 있다.
  // 확장이 먼저 스캔해 버리면 그 선택을 대신 해버린다. 자동 스캔은 사용자가 한 번
  // 스캔해 본 뒤, 그 다음에 새로 붙는 서버부터 적용한다.
  if (args.neverScanned) return { kind: 'skip' };
  if (args.setting === 'always') return { kind: 'scan', targets };
  return { kind: 'prompt', targets };
}
