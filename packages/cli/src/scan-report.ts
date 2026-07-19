// packages/cli/src/scan-report.ts
/** scan 서버별 실패 메시지 포맷. auth-required 오류는 전용 안내 문구로 표기. */
export function scanFailureLine(name: string, err: Error): string {
  if (err.message.includes('auth-required')) {
    return `- ${name}: 인증 필요 — 스킵 (OAuth 지원은 로드맵)`;
  }
  return `- ${name}: 스캔 실패 — ${err.message}`;
}

/** 소스별 발견 수 요약 문자열 (예: "claude-user 2개 · codex 1개"). 발견 0개인 소스는 생략. */
export function formatSourceCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}개`)
    .join(' · ');
}
