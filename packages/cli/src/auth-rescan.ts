// packages/cli/src/auth-rescan.ts
import { type LensStore, type McpServerSpec, scanServer } from '@mcp-lens/core';
import { scanFailureLine } from './scan-report.js';
import { classifyScanFailure } from './scan-status.js';

/**
 * 로그인 직후 서버 1개를 재스캔하고 성공/실패와 무관하게 store를 저장·종료한다.
 * scan을 인자로 받아 테스트에서 실패를 주입할 수 있게 한다(기본값은 실제 scanServer).
 * save/close를 finally 하나로 모아 두 분기(성공/실패) 모두 recordServerScanStatus로
 * 기록한 값이 디스크에 남게 한다 — 이 함수를 만든 이유가 바로 그 보장이다.
 *
 * main.ts에서 이 함수를 분리한 이유: main.ts는 마지막 줄에서 main()을 무조건 실행하므로
 * import만 해도 실제 DB에 접속하는 CLI가 구동된다. runAuthRescan은 부수효과 없는(테스트에서
 * scan을 주입하는) 순수 단위이므로 별도 모듈로 두면 vscode 없는 core 함수들처럼 안전하게
 * import해서 테스트할 수 있다.
 *
 * name 파라미터를 따로 받지 않고 spec.name을 DB 키로 쓴다: 호출부(main.ts runAuth)는
 * resolveAuthTarget(specs, name)으로 spec을 찾는데, resolveAuthTarget이 `s.name === name`
 * 정확히 일치하는 spec만 반환하므로 target.spec.name은 항상 사용자가 입력한 name과 같다.
 * 두 값이 갈라질 수 없으므로 소스를 하나로 유지해 불일치로 고아 row가 생길 여지를 없앤다.
 */
export async function runAuthRescan(
  store: LensStore,
  spec: McpServerSpec,
  scannedAt: string,
  scan: typeof scanServer = scanServer,
): Promise<void> {
  try {
    const result = await scan(spec);
    store.upsertScanResult(result.definitions, result.bodies, []);
    store.recordServerScanStatus(spec.name, 'ok', scannedAt);
    const total = result.definitions.reduce((n, d) => n + d.definitionTokens, 0);
    console.log(`${spec.name}: 로그인 완료, 툴 ${result.definitions.length}개 · ${total}토큰`);
  } catch (e) {
    const record = classifyScanFailure(e);
    store.recordServerScanStatus(spec.name, record.status, scannedAt, record.errorCode);
    console.log(scanFailureLine(spec.name, e));
  } finally {
    store.save();
    store.close();
  }
}
