import { PLUGIN_ID } from '../hookInstall.js';

/** Our bundled hooks.json has one group and one hook per event, so the index is always 0:0. */
const HOOK_EVENTS = ['pre_tool_use', 'post_tool_use', 'session_start', 'stop'] as const;

export const CODEX_HOOK_STATE_KEYS: readonly string[] =
  HOOK_EVENTS.map((event) => `${PLUGIN_ID}:hooks/hooks.json:${event}:0:0`);

export interface CodexHookState {
  key: string;
  /** The section exists and has `enabled = true` */
  enabled: boolean;
  /** The section exists and has `trusted_hash = ...`: evidence of user approval */
  trusted: boolean;
}

function header(key: string): string { return `[hooks.state."${key}"]`; }

/** Finds the header line position and the end of that table body (the next table header, or EOF). */
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

/** Reads the state of our four hooks from the raw config.toml. */
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
 * Returns the text with `enabled = true` guaranteed on our four hooks. Already-enabled ones are left alone.
 *
 * `trusted_hash` is never written: it is evidence of user approval and must not be forged.
 * A missing section is appended at the end of the file as a new table. It starts with a new table
 * header, so appending after any table keeps the TOML structure intact.
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
    // enabled is missing or false: strip the existing enabled line and put true right under the header.
    lines = [
      ...lines.slice(0, at.start + 1),
      'enabled = true',
      ...body.filter((line) => !/^\s*enabled\s*=/.test(line)),
      ...lines.slice(at.end),
    ];
  }
  return lines.join('\n');
}
