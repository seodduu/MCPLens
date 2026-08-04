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
 */
export function classifyScanFailure(err: Error): ScanStatusRecord {
  const msg = err.message;
  if (msg.includes('auth-required') || msg.includes('token-expired')) {
    return { status: 'auth-required' };
  }
  return { status: 'failed', errorCode: msg.slice(0, 120) };
}
