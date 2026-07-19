// packages/cli/src/auth-target.ts
import { specTransport, type McpServerSpec } from '@mcp-lens/core';

/** auth 커맨드의 대상 검증 결과 (순수 함수 — 유닛테스트 가능하게 분리). */
export type AuthTargetResult =
  | { ok: true; spec: McpServerSpec }
  | { ok: false; message: string };

/**
 * 이름으로 인증 대상 spec을 찾는다.
 * 없거나 stdio 서버(http만 인증 대상)면 안내 메시지와 함께 실패를 반환한다.
 */
export function resolveAuthTarget(specs: McpServerSpec[], name: string): AuthTargetResult {
  const spec = specs.find((s) => s.name === name);
  if (!spec) {
    return {
      ok: false,
      message: `${name}: 서버를 찾을 수 없습니다 (mcp-lens scan 으로 등록된 서버를 확인하세요)`,
    };
  }
  if (specTransport(spec) !== 'http') {
    return {
      ok: false,
      message: `${name}: stdio 서버는 인증이 필요 없습니다 (http 서버만 지원)`,
    };
  }
  return { ok: true, spec };
}
