import { parse as parseToml } from 'smol-toml';

export type TomlArrayPatchResult =
  | { status: 'patched'; value: string }
  | { status: 'unchanged'; value: string }
  | { status: 'invalid' };

type PatchOperation = 'add' | 'remove';

/**
 * TOML을 다시 직렬화하지 않고 특정 MCP 서버 테이블의 disabled_tools만 바꾼다.
 * `smol-toml`은 입력과 결과의 의미 검증에만 쓰므로, 관련 없는 주석과 바이트는 보존된다.
 */
export function patchDisabledTools(
  source: string,
  serverName: string,
  toolName: string,
  operation: PatchOperation = 'add',
  preserveEmptyArray = true,
): TomlArrayPatchResult {
  const parsed = parseConfig(source);
  const table = serverTable(parsed, serverName);
  if (table === null) return { status: 'invalid' };
  const values = table.disabled_tools;
  if (values !== undefined && (!Array.isArray(values) || !values.every((value) => typeof value === 'string'))) return { status: 'invalid' };

  const current = (values ?? []) as string[];
  if (operation === 'add' && current.includes(toolName)) return { status: 'unchanged', value: source };
  if (operation === 'remove' && !current.includes(toolName)) return { status: 'unchanged', value: source };

  const target = findServerTable(source, serverName);
  if (target === null) return { status: 'invalid' };
  const property = findDisabledToolsProperty(source, target);
  if (property === 'duplicate') return { status: 'invalid' };
  if (property === null && values !== undefined) return { status: 'invalid' };

  const next = operation === 'add' ? [...current, toolName] : current.filter((value) => value !== toolName);
  let value: string;
  if (property !== null && operation === 'remove' && next.length === 0 && !preserveEmptyArray) {
    value = source.slice(0, property.lineStart) + source.slice(property.lineEnd);
  } else if (property !== null) {
    value = source.slice(0, property.valueStart) + renderArray(next, source, property.valueStart, property.valueEnd) + source.slice(property.valueEnd);
  } else {
    value = insertProperty(source, target, renderArray(next, source, target.start, target.start));
  }

  if (parseConfig(value) === null) return { status: 'invalid' };
  return { status: 'patched', value };
}

type TomlObject = Record<string, unknown>;
interface TableRange { start: number; bodyStart: number; end: number; }
interface PropertyRange { lineStart: number; lineEnd: number; valueStart: number; valueEnd: number; }

function parseConfig(source: string): TomlObject | null {
  try {
    // smol-toml은 BOM을 허용하지 않지만, Codex 설정 원문은 BOM을 보존한 채 지원해야 한다.
    const value: unknown = parseToml(source.replace(/^\uFEFF/, ''));
    return value !== null && !Array.isArray(value) && typeof value === 'object' ? value as TomlObject : null;
  } catch {
    return null;
  }
}

function serverTable(parsed: TomlObject | null, serverName: string): TomlObject | null {
  const servers = parsed?.mcp_servers;
  if (servers === null || Array.isArray(servers) || typeof servers !== 'object') return null;
  const table = (servers as TomlObject)[serverName];
  return table !== null && !Array.isArray(table) && typeof table === 'object' ? table as TomlObject : null;
}

function findServerTable(source: string, serverName: string): TableRange | null {
  const multilineLines = multilineStringLines(source);
  const headers = [...source.matchAll(/^[ \t]*\[([^\]\r\n]+)\][^\r\n]*(?:\r?\n|$)/gm)];
  const actualHeaders = headers.filter((header) => !multilineLines.has(header.index!));
  const matches = actualHeaders.filter((header) => headerPath(header[1])?.length === 2 && headerPath(header[1])?.[0] === 'mcp_servers' && headerPath(header[1])?.[1] === serverName);
  if (matches.length !== 1) return null;
  const header = matches[0];
  const start = header.index!;
  return { start, bodyStart: start + header[0].length, end: actualHeaders.find((candidate) => candidate.index! > start)?.index ?? source.length };
}

function headerPath(header: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  while (index < header.length) {
    while (/\s/.test(header[index] ?? '')) index++;
    const quote = header[index];
    if (quote === '"' || quote === "'") {
      const end = header.indexOf(quote, index + 1);
      if (end < 0) return null;
      parts.push(header.slice(index + 1, end));
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(header.slice(index));
      if (match === null) return null;
      parts.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(header[index] ?? '')) index++;
    if (index === header.length) return parts;
    if (header[index] !== '.') return null;
    index++;
  }
  return null;
}

function findDisabledToolsProperty(source: string, table: TableRange): PropertyRange | null | 'duplicate' {
  const body = source.slice(table.bodyStart, table.end);
  const multilineLines = multilineStringLines(source);
  const matches = [...body.matchAll(/^([ \t]*)disabled_tools[ \t]*=[ \t]*/gm)]
    .filter((match) => !multilineLines.has(table.bodyStart + match.index!));
  if (matches.length > 1) return 'duplicate';
  if (matches.length === 0) return null;
  const match = matches[0];
  const valueStart = table.bodyStart + match.index! + match[0].length;
  if (source[valueStart] !== '[') return 'duplicate';
  const valueEnd = arrayEnd(source, valueStart, table.end);
  if (valueEnd === null) return 'duplicate';
  const lineStart = table.bodyStart + match.index!;
  const lineEnd = valueEnd + (source.slice(valueEnd).match(/^(?:\r?\n)/)?.[0].length ?? 0);
  return { lineStart, lineEnd, valueStart, valueEnd };
}

/** 실제 TOML의 multiline basic/literal string에 속한 행을 식별한다. */
function multilineStringLines(source: string): Set<number> {
  const lines = new Set<number>();
  let state: 'basic' | 'literal' | null = null;
  let lineStart = 0;
  for (let index = 0; index < source.length;) {
    if (state !== null) lines.add(lineStart);
    const char = source[index];
    if (char === '\n') { lineStart = index + 1; index++; continue; }
    const delimiter = state === 'basic' ? '"""' : state === 'literal' ? "'''" : null;
    if (delimiter !== null) {
      if (source.startsWith(delimiter, index)) { state = null; index += 3; continue; }
      if (state === 'basic' && char === '\\') { index += 2; continue; }
      index++;
      continue;
    }
    if (char === '#') { const newline = source.indexOf('\n', index); index = newline < 0 ? source.length : newline; continue; }
    if (source.startsWith('"""', index)) { state = 'basic'; index += 3; continue; }
    if (source.startsWith("'''", index)) { state = 'literal'; index += 3; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      index++;
      while (index < source.length && source[index] !== '\n') {
        if (source[index] === '\\' && quote === '"') index += 2;
        else if (source[index++] === quote) break;
      }
      continue;
    }
    index++;
  }
  return lines;
}

function hasArrayComment(value: string): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (const char of value) {
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return true;
  }
  return false;
}

function arrayEnd(source: string, start: number, limit: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let comment = false;
  for (let index = start; index < limit; index++) {
    const char = source[index];
    if (comment) {
      if (char === '\n') comment = false;
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') { comment = true; continue; }
    if (char === '[') depth++;
    if (char === ']' && --depth === 0) return index + 1;
  }
  return null;
}

function renderArray(values: readonly string[], source: string, start: number, end: number): string {
  const original = source.slice(start, end);
  if (hasArrayComment(original)) return patchCommentedArray(original, values, source);
  if (!original.includes('\n') && !original.includes('\r')) return `[${values.map(quote).join(', ')}]`;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const following = source.slice(start + 1, end);
  const indentation = /(?:\r?\n)([ \t]+)\S/.exec(following)?.[1] ?? '  ';
  return `[${newline}${values.map((value) => `${indentation}${quote(value)},`).join(newline)}${newline}]`;
}

function patchCommentedArray(original: string, values: readonly string[], source: string): string {
  const originalValues = stringsFromArray(original);
  if (originalValues === null) return original;
  const added = values.find((value) => !originalValues.includes(value));
  if (added !== undefined) {
    const closing = original.lastIndexOf(']');
    const beforeClosing = original.slice(0, closing);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const indentation = /(?:^|\r?\n)([ \t]*)[^\r\n]*\r?\n$/.exec(beforeClosing)?.[1] ?? '  ';
    return `${beforeClosing}${indentation}${quote(added)},${newline}]`;
  }
  const removed = originalValues.find((value) => !values.includes(value));
  if (removed === undefined) return original;
  const token = escapeRegExp(quote(removed));
  const line = new RegExp(`(\\r?\\n)[ \\t]*${token}[ \\t]*,?(?:[ \\t]*#.*)?(\\r?\\n)`);
  return original.replace(line, '$1');
}

function stringsFromArray(value: string): string[] | null {
  try {
    const parsed = parseToml(`value = ${value.replace(/^\uFEFF/, '')}`) as Record<string, unknown>;
    return Array.isArray(parsed.value) && parsed.value.every((item) => typeof item === 'string') ? parsed.value as string[] : null;
  } catch { return null; }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function insertProperty(source: string, table: TableRange, rendered: string): string {
  const body = source.slice(table.bodyStart, table.end);
  const trailing = /(?:\r?\n)+$/.exec(body)?.[0] ?? '';
  const at = table.end - trailing.length;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const prefix = at === table.bodyStart ? '' : newline;
  return source.slice(0, at) + `${prefix}disabled_tools = ${rendered}` + (trailing || newline) + source.slice(table.end);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
