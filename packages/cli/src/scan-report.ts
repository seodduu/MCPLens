// packages/cli/src/scan-report.ts
/**
 * scan 서버별 실패 메시지 포맷. auth-required 오류는 전용 안내 문구로 표기.
 * err는 unknown으로 받는다 — scanServer가 SDK 예외를 그대로 재던지므로 Error가 아닌 값이
 * 들어올 수 있고, err.message로 단정하면 이 함수를 부르는 scan 루프 자체가 죽어
 * 그 시점까지의 recordServerScanStatus 기록이 store.save() 전에 유실된다
 * (classifyScanFailure와 같은 이유로 같은 방식으로 정규화한다).
 */
export function scanFailureLine(name: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth-required')) {
    return `- ${name}: 인증 필요 — 스킵 (npx mcp-lens auth ${name} 로 로그인)`;
  }
  return `- ${name}: 스캔 실패 — ${msg}`;
}

/** 소스별 발견 수 요약 문자열 (예: "claude-user 2개 · codex 1개"). 발견 0개인 소스는 생략. */
export function formatSourceCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}개`)
    .join(' · ');
}
