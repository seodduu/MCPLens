// packages/cli/src/scan-status.ts
export interface ScanStatusRecord {
  status: 'ok' | 'auth-required' | 'failed';
  errorCode?: string;
}

/**
 * 스캔 예외를 server_scan_status 값으로 분류한다.
 * packages/extension/src/autoScan.ts의 분류 규칙과 동일하게 유지한다:
 * auth-required/token-expired 메시지는 auth-required(errorCode 없음),
 * 그 외는 failed(errorCode는 최대 120자로 자름).
 * err는 unknown으로 받는다 — scanServer는 SDK 예외를 그대로 재던지므로 Error가 아닌
 * 값(문자열 등)이 들어올 수 있고, Error로 단정해 err.message에 접근하면 catch 블록
 * 안에서 TypeError가 나 store.save()까지 못 가고 그 실행의 기록이 전부 유실된다.
 */
export function classifyScanFailure(err: unknown): ScanStatusRecord {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth-required') || msg.includes('token-expired')) {
    return { status: 'auth-required' };
  }
  return { status: 'failed', errorCode: msg.slice(0, 120) };
}
