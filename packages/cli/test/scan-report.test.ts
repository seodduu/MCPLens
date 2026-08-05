import { describe, it, expect } from 'vitest';
import { scanFailureLine, formatSourceCounts } from '../src/scan-report.js';

describe('scanFailureLine', () => {
  it('formats auth-required errors as authentication guidance', () => {
    const line = scanFailureLine('remote-http', new Error('auth-required: 401 from server'));
    expect(line).toBe('- remote-http: authentication required, skipped (log in with npx mcp-lens auth remote-http)');
  });

  it('formats other errors as a plain failure line', () => {
    const line = scanFailureLine('flaky', new Error('spawn ENOENT'));
    expect(line).toBe('- flaky: scan failed: spawn ENOENT');
  });
});

describe('formatSourceCounts', () => {
  it('omits sources with 0 finds and joins the rest with ·', () => {
    expect(formatSourceCounts({ 'claude-user': 2, 'claude-project': 0, codex: 1 }))
      .toBe('claude-user 2 · codex 1');
  });

  it('returns an empty string when everything is 0', () => {
    expect(formatSourceCounts({ codex: 0 })).toBe('');
  });
});
