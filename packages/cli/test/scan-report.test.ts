import { describe, it, expect } from 'vitest';
import { scanFailureLine, formatSourceCounts } from '../src/scan-report.js';

describe('scanFailureLine', () => {
  it('auth-required 오류는 인증 필요 안내로 표기한다', () => {
    const line = scanFailureLine('remote-http', new Error('auth-required: 401 from server'));
    expect(line).toBe('- remote-http: 인증 필요 — 스킵 (OAuth 지원은 로드맵)');
  });

  it('그 외 오류는 일반 실패 메시지를 표기한다', () => {
    const line = scanFailureLine('flaky', new Error('spawn ENOENT'));
    expect(line).toBe('- flaky: 스캔 실패 — spawn ENOENT');
  });
});

describe('formatSourceCounts', () => {
  it('발견 수 0인 소스는 생략하고 · 로 연결한다', () => {
    expect(formatSourceCounts({ 'claude-user': 2, 'claude-project': 0, codex: 1 }))
      .toBe('claude-user 2개 · codex 1개');
  });

  it('전부 0이면 빈 문자열을 반환한다', () => {
    expect(formatSourceCounts({ codex: 0 })).toBe('');
  });
});
