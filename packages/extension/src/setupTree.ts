import type { ServerScanStatus } from '@mcp-lens/core';

/** Setup Status 뷰의 최상위 그룹 3개. 순서 고정 — 트리 렌더링도 이 순서를 따른다. */
export type SetupGroup = 'MCP authentication' | 'Dependency analysis' | 'Global actions';

/** setupTreeProvider.ts가 ThemeIcon으로 매핑하는 아이콘 이름. */
export type SetupIcon =
  | 'pass' | 'warning' | 'circle-outline' | 'error' | 'circle-slash' | 'account' | 'lock' | 'unlock';

export interface SetupRow {
  group: SetupGroup;
  label: string;
  description: string;
  icon: SetupIcon;
  /** 클릭 시 실행할 커맨드 id. 없으면(undefined) 이 행은 클릭해도 아무 일도 안 한다. */
  command?: string;
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

function authRow(input: BuildSetupRowsInput, serverName: string): SetupRow {
  if (input.unsupported.includes(serverName)) {
    return { group: 'MCP authentication', label: serverName, description: 'not supported by Lens', icon: 'circle-slash' };
  }
  if (input.authIgnore.includes(serverName)) {
    return { group: 'MCP authentication', label: serverName, description: 'ignored', icon: 'circle-slash' };
  }
  const status = input.scanStatuses.get(serverName);
  if (!status) {
    return { group: 'MCP authentication', label: serverName, description: 'run a scan', icon: 'circle-outline', command: 'mcp-lens.scanNow' };
  }
  if (status.status === 'ok') {
    return { group: 'MCP authentication', label: serverName, description: 'authenticated', icon: 'pass' };
  }
  if (status.status === 'auth-required') {
    return { group: 'MCP authentication', label: serverName, description: 'sign in to scan', icon: 'warning', command: 'mcp-lens.authenticateServer' };
  }
  // failed
  return {
    group: 'MCP authentication', label: serverName, description: status.errorCode ?? 'scan failed',
    icon: 'error', command: 'mcp-lens.scanNow',
  };
}

function providerRow(input: BuildSetupRowsInput): SetupRow {
  const description = input.consent ? `${input.consent.provider} · consented` : 'consent required';
  return {
    group: 'Dependency analysis', label: 'Provider', description, icon: 'account',
    command: 'mcplens.analyzeDependencies',
  };
}

function analysisRow(input: BuildSetupRowsInput, serverName: string): SetupRow {
  if (input.analyzedServers.has(serverName)) {
    return { group: 'Dependency analysis', label: serverName, description: 'analyzed', icon: 'pass' };
  }
  return {
    group: 'Dependency analysis', label: serverName, description: 'not analyzed',
    icon: 'circle-outline', command: 'mcplens.reanalyzeServer',
  };
}

function globalActionsRow(input: BuildSetupRowsInput): SetupRow {
  const locked = input.rollout === 'off';
  return {
    group: 'Global actions', label: 'Global actions',
    description: locked ? 'locked' : `enabled (${input.rollout})`,
    icon: locked ? 'lock' : 'unlock',
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
