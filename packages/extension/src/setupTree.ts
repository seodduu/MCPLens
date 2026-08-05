import type { ServerScanStatus } from '@mcp-lens/core';

/** Setup Status 뷰의 최상위 그룹 4개. 순서 고정 — 트리 렌더링도 이 순서를 따른다.
 * Collection은 옛 Collection Status 뷰를 흡수한 것이다. 행이 2~3개뿐인데 사이드바
 * 섹션을 통째로 차지해, 정작 봐야 할 매트릭스가 밀려 있었다. */
export type SetupGroup =
  'Collection' | 'MCP authentication' | 'Dependency analysis' | 'Global actions';

/** setupTreeProvider.ts가 ThemeIcon으로 매핑하는 아이콘 이름. */
export type SetupIcon =
  | 'pass' | 'warning' | 'circle-outline' | 'error' | 'circle-slash' | 'account' | 'lock' | 'unlock'
  | 'clock';

export interface SetupRow {
  group: SetupGroup;
  label: string;
  description: string;
  icon: SetupIcon;
  /** 클릭 시 실행할 커맨드 id. 없으면(undefined) 이 행은 클릭해도 아무 일도 안 한다. */
  command?: string;
  /** 커맨드 인자. 생략하면 `[{ serverName: label }]`(서버 행 관례)로 넘어간다. */
  commandArgs?: unknown[];
  /** 호버 설명. 수집 상태처럼 한 줄로 못 담는 행에만 채운다. */
  tooltip?: string;
  /** 아이콘 강조색(ThemeColor id). 없으면 기본색. */
  colorId?: string;
  /** view/item/context 메뉴 라우팅용. */
  contextValue?: string;
  /** TreeItem id — 같은 label이 그룹 간에 겹칠 때 구분한다. 없으면 `group/label`. */
  id?: string;
}

export interface BuildSetupRowsInput {
  /** collectAllSpecs()로 얻은 전체 MCP 서버 이름. */
  serverNames: string[];
  scanStatuses: ReadonlyMap<string, ServerScanStatus>;
  /** mcpLens.authIgnore 설정 — 로그인 알림을 영구 억제한 서버. */
  authIgnore: string[];
  /** mcpLens.unsupportedServers 설정 — Lens가 지원하지 않는 서버. */
  unsupported: string[];
  /** 정의가 있고 findDependencyAnalysis가 결과를 준 서버. */
  analyzedServers: Set<string>;
  /** 툴 정의가 하나 이상 있는 서버 — 분석 그룹의 모수. */
  definitionServers: Set<string>;
  consent?: { provider: string; model: string };
  rollout: string;
}

/**
 * 상태 색은 세 갈래뿐이다. 회색 아이콘만 늘어놓으면 어느 줄이 내 일인지 훑어서 알 수 없다.
 * DONE(파랑): 더 할 일 없음. 수집 그룹의 Healthy와 같은 색을 써서 한 뷰 안에서 뜻이 갈리지 않게 한다.
 * TODO(노랑): 아직 안 한 일이라 사용자가 눌러야 한다.
 * BROKEN(빨강): 시도했는데 실패했다.
 * 의도적으로 범위 밖인 줄(ignored·not supported)은 색을 주지 않는다. 눈에 띄면 안 되는 줄이다.
 */
const DONE = 'charts.blue';
const TODO = 'charts.yellow';
const BROKEN = 'charts.red';

function authRow(input: BuildSetupRowsInput, serverName: string): SetupRow {
  if (input.unsupported.includes(serverName)) {
    return { group: 'MCP authentication', label: serverName, description: 'not supported by Lens', icon: 'circle-slash' };
  }
  if (input.authIgnore.includes(serverName)) {
    // 무시는 사용자가 스스로 끈 것이라 언제든 되돌릴 수 있다. 회색으로 묻어두면
    // 그 서버의 비용이 계속 안 잡히는데도 눈에 안 띄므로 빨강으로 남긴다.
    return { group: 'MCP authentication', label: serverName, description: 'ignored', icon: 'circle-slash', colorId: BROKEN };
  }
  const status = input.scanStatuses.get(serverName);
  if (!status) {
    return { group: 'MCP authentication', label: serverName, description: 'run a scan', icon: 'circle-outline', colorId: TODO, command: 'mcp-lens.scanNow' };
  }
  if (status.status === 'ok') {
    return { group: 'MCP authentication', label: serverName, description: 'authenticated', icon: 'pass', colorId: DONE };
  }
  if (status.status === 'auth-required') {
    return { group: 'MCP authentication', label: serverName, description: 'sign in to scan', icon: 'warning', colorId: TODO, command: 'mcp-lens.authenticateServer' };
  }
  // failed
  return {
    group: 'MCP authentication', label: serverName, description: status.errorCode ?? 'scan failed',
    icon: 'error', colorId: BROKEN, command: 'mcp-lens.scanNow',
  };
}

function providerRow(input: BuildSetupRowsInput): SetupRow {
  const description = input.consent ? `${input.consent.provider} · consented` : 'consent required';
  return {
    group: 'Dependency analysis', label: 'Provider', description, icon: 'account',
    colorId: input.consent ? DONE : TODO,
    command: 'mcplens.analyzeDependencies',
  };
}

function analysisRow(input: BuildSetupRowsInput, serverName: string): SetupRow {
  if (input.analyzedServers.has(serverName)) {
    return { group: 'Dependency analysis', label: serverName, description: 'analyzed', icon: 'pass', colorId: DONE };
  }
  return {
    group: 'Dependency analysis', label: serverName, description: 'not analyzed',
    icon: 'circle-outline', colorId: TODO, command: 'mcplens.reanalyzeServer',
  };
}

function globalActionsRow(input: BuildSetupRowsInput): SetupRow {
  const locked = input.rollout === 'off';
  return {
    group: 'Global actions', label: 'Global actions',
    description: locked ? 'locked' : `enabled (${input.rollout})`,
    icon: locked ? 'lock' : 'unlock',
    // 잠김은 고장이 아니라 기본값이다. 켜야 할 일이 남았다는 뜻이므로 TODO 색을 쓴다.
    colorId: locked ? TODO : DONE,
    command: 'mcp-lens.openRolloutSetting',
  };
}

/** vscode를 참조하지 않는 순수 함수 — 어느 서버가 어떤 상태인지만 판정한다. */
export function buildSetupRows(input: BuildSetupRowsInput): SetupRow[] {
  return [
    ...input.serverNames.map((name) => authRow(input, name)),
    providerRow(input),
    ...input.serverNames.filter((name) => input.definitionServers.has(name))
      .map((name) => analysisRow(input, name)),
    globalActionsRow(input),
  ];
}
