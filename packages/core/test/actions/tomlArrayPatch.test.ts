import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { patchDisabledTools } from '../../src/actions/tomlArrayPatch.js';

const fixtures = join(__dirname, '..', '..', '..', '..', 'fixtures', 'actions', 'codex');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

describe('patchDisabledTools', () => {
  it('replaces only the target array while retaining BOM, CRLF, comments, unknown values, and table order', () => {
    const source = fixture('comments-and-unknown.toml').replace(/\n/g, '\r\n');

    const result = patchDisabledTools(source, 'github.enterprise', 'search');

    expect(result).toEqual({
      status: 'patched',
      value: '\uFEFF# keep this comment\r\n[mcp_servers."github.enterprise"]\r\ncommand = "npx" # keep command comment\r\ndisabled_tools = [\r\n  "issues",\r\n  "search",\r\n]\r\nunknown_key = { retained = true }\r\n\r\n[unrelated]\r\nanswer = 42\r\n',
    });
  });

  it('adds disabled_tools inside the exact quoted server table without changing adjacent tables', () => {
    const source = '[mcp_servers."github.enterprise"]\ncommand = "npx"\n\n[mcp_servers.github]\ncommand = "other"\n';

    const result = patchDisabledTools(source, 'github.enterprise', 'search');

    expect(result).toEqual({
      status: 'patched',
      value: '[mcp_servers."github.enterprise"]\ncommand = "npx"\ndisabled_tools = ["search"]\n\n[mcp_servers.github]\ncommand = "other"\n',
    });
  });

  it('refuses absent or duplicate server tables and non-string disabled_tools arrays', () => {
    expect(patchDisabledTools('[mcp_servers.other]\ncommand = "npx"\n', 'github', 'search')).toEqual({ status: 'invalid' });
    expect(patchDisabledTools('[mcp_servers.github]\n[mcp_servers.github]\n', 'github', 'search')).toEqual({ status: 'invalid' });
    expect(patchDisabledTools('[mcp_servers.github]\ndisabled_tools = ["search", 7]\n', 'github', 'search')).toEqual({ status: 'invalid' });
  });

  it('does not mistake multiline basic or literal string contents for a disabled_tools key', () => {
    for (const quote of ['"""', "'''"]) {
      const source = `[mcp_servers.github]\nnotes = ${quote}\ndisabled_tools = ["not-a-key"] # keep this text\n${quote}\ncommand = "npx"\n`;

      expect(patchDisabledTools(source, 'github', 'search')).toEqual({
        status: 'patched',
        value: `[mcp_servers.github]\nnotes = ${quote}\ndisabled_tools = ["not-a-key"] # keep this text\n${quote}\ncommand = "npx"\ndisabled_tools = ["search"]\n`,
      });
    }
  });

  it('preserves comments, whitespace, and line endings inside disabled_tools when adding and removing the owned item', () => {
    const source = '[mcp_servers.github]\ndisabled_tools = [\n  "issues", # user rationale\n]\n';
    const added = '[mcp_servers.github]\ndisabled_tools = [\n  "issues", # user rationale\n  "search",\n]\n';

    expect(patchDisabledTools(source, 'github', 'search')).toEqual({ status: 'patched', value: added });
    expect(patchDisabledTools(added, 'github', 'search', 'remove')).toEqual({ status: 'patched', value: source });
  });
});
