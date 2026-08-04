// packages/cli/src/scan-run.ts
import { type LensStore, type McpServerSpec, type ServerIdentity, scanServer } from '@mcp-lens/core';
import { scanFailureLine } from './scan-report.js';
import { classifyScanFailure } from './scan-status.js';

/** 서버 1개 스캔 결과 — 호출자가 기존 콘솔 출력 포맷을 그대로 이어 찍을 수 있게 필요한 값만 담는다. */
export type ScanOneResult =
  | { ok: true; toolCount: number; totalTokens: number }
  | { ok: false; line: string };

/**
 * `mcp-lens scan` 루프의 서버 1개 처리 단위를 뽑아낸 순수 함수.
 * scan을 성공/실패 어느 쪽이든 recordServerScanStatus로 반드시 기록하고, 예외를
 * 호출자에게 절대 던지지 않는다 — 그래야 여러 서버를 도는 for 루프에서 한 서버의
 * 실패가 나머지 서버의 기록과 마지막 store.save()를 통째로 날리지 못한다.
 * scan을 인자로 받아 테스트에서 실패를 주입할 수 있게 한다(기본값은 실제 scanServer).
 */
export async function scanOneServer(
  store: LensStore,
  spec: McpServerSpec,
  scannedAt: string,
  identities: ServerIdentity[],
  scan: typeof scanServer = scanServer,
): Promise<ScanOneResult> {
  try {
    const result = await scan(spec);
    store.upsertScanResult(
      result.definitions,
      result.bodies,
      identities.filter((identity) => identity.serverName === spec.name),
    );
    store.recordServerScanStatus(spec.name, 'ok', scannedAt);
    const totalTokens = result.definitions.reduce((n, d) => n + d.definitionTokens, 0);
    return { ok: true, toolCount: result.definitions.length, totalTokens };
  } catch (e) {
    const record = classifyScanFailure(e);
    store.recordServerScanStatus(spec.name, record.status, scannedAt, record.errorCode);
    return { ok: false, line: scanFailureLine(spec.name, e) };
  }
}
