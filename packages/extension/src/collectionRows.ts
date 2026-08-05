// vscode import 금지 — Setup Status 뷰의 한 그룹을 만드는 순수 행 빌더다.
import { clientRowPresentation, type CollectionHealthPresentation, type CollectionHealthSnapshot } from './hookStatus.js';
import type { HookClient, InstallState } from './hookInstall.js';
import type { SetupIcon, SetupRow } from './setupTree.js';

const ICON: Record<CollectionHealthPresentation['severity'], SetupIcon> = {
  ok: 'pass', info: 'clock', warning: 'warning', error: 'error', idle: 'circle-outline',
};

/** 수집상태 색: hook 살아있으면 파랑, 로그만이면 주황, 모두 없으면 빨강. */
function collectionColor(snapshot?: CollectionHealthSnapshot): string {
  if (snapshot?.hookObserved) return 'charts.blue';
  if (snapshot?.logObserved) return 'charts.orange';
  return 'charts.red';
}

export interface ClientRowInput {
  client: HookClient;
  install: InstallState;
  snapshot?: CollectionHealthSnapshot;
}

export interface ClientRow {
  client: HookClient;
  label: string;
  description: string;
  tooltip: string;
  severity: CollectionHealthPresentation['severity'];
  /** 아이콘 강조색 — hook 파랑 / 로그만 주황 / 없음 빨강 */
  colorId: string;
  contextValue: 'hook-installable' | 'hook-installed';
}

export function toRow(input: ClientRowInput): ClientRow {
  const p = clientRowPresentation(input.install, input.snapshot);
  return {
    client: input.client,
    label: `${input.client}: ${p.label}`,
    description: p.description,
    tooltip: p.tooltip,
    severity: p.severity,
    colorId: collectionColor(input.snapshot),
    contextValue: input.install === 'not-installed' ? 'hook-installable' : 'hook-installed',
  };
}

/**
 * 클라이언트별 수집 상태를 Setup Status 뷰의 Collection 그룹 행으로 만든다.
 * `client-missing`(그 클라이언트가 아예 설치돼 있지 않음)은 보여줄 것이 없으므로 제외한다.
 */
export function collectionRows(inputs: ClientRowInput[]): SetupRow[] {
  return inputs.filter((i) => i.install !== 'client-missing').map(toRow).map((row): SetupRow => ({
    group: 'Collection',
    label: row.label,
    description: row.description,
    icon: ICON[row.severity],
    tooltip: row.tooltip,
    colorId: row.colorId,
    contextValue: row.contextValue,
    id: row.client,
    // 정상 행에는 클릭 동작을 두지 않는다 — 고칠 게 없는 행이다.
    ...(row.severity === 'warning' || row.severity === 'error'
      ? { command: 'mcp-lens.hooksDoctor', commandArgs: [row.client] }
      : {}),
  }));
}
