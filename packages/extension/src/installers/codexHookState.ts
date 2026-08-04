import { PLUGIN_ID } from '../hookInstall.js';

/** 우리 번들 hooks.json은 이벤트마다 그룹 1개·훅 1개라 인덱스가 항상 0:0이다. */
const HOOK_EVENTS = ['pre_tool_use', 'post_tool_use', 'session_start', 'stop'] as const;

export const CODEX_HOOK_STATE_KEYS: readonly string[] =
  HOOK_EVENTS.map((event) => `${PLUGIN_ID}:hooks/hooks.json:${event}:0:0`);

export interface CodexHookState {
  key: string;
  /** 섹션이 존재하고 `enabled = true`가 있다 */
  enabled: boolean;
  /** 섹션이 존재하고 `trusted_hash = ...`가 있다 — 사용자 승인의 증거 */
  trusted: boolean;
}

function header(key: string): string { return `[hooks.state."${key}"]`; }

/** 헤더 줄 위치와 그 테이블 본문의 끝(다음 테이블 헤더 또는 EOF)을 찾는다. */
function locate(lines: readonly string[], key: string): { start: number; end: number } | null {
  const want = header(key);
  const start = lines.findIndex((line) => line.trim() === want);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) { end = i; break; }
  }
  return { start, end };
}

/** config.toml 원문에서 우리 훅 4개의 상태를 읽는다. */
export function readCodexHookStates(content: string): CodexHookState[] {
  const lines = content.split('\n');
  return CODEX_HOOK_STATE_KEYS.map((key) => {
    const at = locate(lines, key);
    if (at === null) return { key, enabled: false, trusted: false };
    const body = lines.slice(at.start + 1, at.end);
    return {
      key,
      enabled: body.some((line) => /^\s*enabled\s*=\s*true\s*$/.test(line)),
      trusted: body.some((line) => /^\s*trusted_hash\s*=/.test(line)),
    };
  });
}

/**
 * 우리 훅 4개에 `enabled = true`를 보장한 원문을 돌려준다. 이미 켜져 있으면 그대로 둔다.
 *
 * `trusted_hash`는 절대 쓰지 않는다 — 사용자 승인의 증거이므로 위조 대상이 아니다.
 * 섹션이 없으면 파일 끝에 새 테이블로 붙인다. 새 테이블 헤더로 시작하므로 어떤 테이블
 * 뒤에 붙어도 TOML 구조가 깨지지 않는다.
 */
export function withCodexHooksEnabled(content: string): string {
  let lines = content.split('\n');
  for (const key of CODEX_HOOK_STATE_KEYS) {
    const at = locate(lines, key);
    if (at === null) {
      if (lines.length > 0 && lines.at(-1)!.trim() !== '') lines.push('');
      lines.push(header(key), 'enabled = true', '');
      continue;
    }
    const body = lines.slice(at.start + 1, at.end);
    if (body.some((line) => /^\s*enabled\s*=\s*true\s*$/.test(line))) continue;
    // enabled가 없거나 false다 — 기존 enabled 줄을 걷어내고 헤더 바로 아래에 true를 넣는다.
    lines = [
      ...lines.slice(0, at.start + 1),
      'enabled = true',
      ...body.filter((line) => !/^\s*enabled\s*=/.test(line)),
      ...lines.slice(at.end),
    ];
  }
  return lines.join('\n');
}
