// packages/cli/src/writer-lease.ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLease, renewLease, releaseLease, dbWriterLockPath, type Lease } from '@mcp-lens/core';

/**
 * CLI용 writer lease.
 *
 * 저장 경로가 "sql.js 전체 파일 export + 원자적 rename"이라 DB 파일을 쓰는 프로세스는
 * 항상 하나여야 한다. VS Code 확장이 살아 있는 동안 CLI가 리스 없이 save()하면,
 * CLI가 open한 뒤 확장이 적재한 관측이 통째로 덮여 사라진다. 그래서 쓰기 커맨드는
 * 확장과 같은 락(dbWriterLockPath)을 두고 경쟁하고, 획득한 쪽만 저장한다.
 *
 * 확장 쪽 WriterLeaseManager와 같은 저수준 API(core의 acquire/renew/releaseLease)를
 * 쓰지만, CLI는 단발성 프로세스라 강등·승격 상태 기계가 필요 없다. 획득 아니면 중단이다.
 */

export interface WriterLeaseDeps {
  acquire: (lockPath: string, ttlMs: number) => Lease | null;
  renew: (lockPath: string, token: string, ttlMs: number) => Lease | null;
  release: (lockPath: string, token: string) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  ensureDir: (dir: string) => void;
  lockPath: () => string;
  ttlMs: number;
  renewMs: number;
}

const DEFAULT_DEPS: WriterLeaseDeps = {
  acquire: acquireLease,
  renew: renewLease,
  release: releaseLease,
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    // 하트비트 타이머가 이벤트 루프를 붙잡아 CLI가 안 끝나는 일을 막는다.
    timer.unref?.();
    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  ensureDir: (dir) => { mkdirSync(dir, { recursive: true }); },
  lockPath: () => dbWriterLockPath(),
  ttlMs: 30_000,
  renewMs: 10_000,
};

export const LEASE_BUSY_MESSAGE =
  'VS Code 확장이 MCP Lens DB를 쓰는 중이라 지금은 이 명령을 실행할 수 없습니다.\n' +
  '확장 창(또는 실행 중인 다른 mcp-lens)을 닫은 뒤 다시 시도하세요. 잠시 후 자동으로 풀리기도 합니다.';

export interface WriterLeaseHandle {
  /** 지금도 내가 홀더인가. 하트비트가 인수를 감지하면 false로 바뀐다. */
  isHolder(): boolean;
  /** 해제는 여러 번 불러도 안전하다. */
  release(): void;
}

export type WriterLeaseResult =
  | { ok: true; lease: WriterLeaseHandle }
  | { ok: false; message: string };

/** 리스를 한 번 시도한다. 유효한 다른 홀더가 있으면 안내 메시지와 함께 실패를 돌려준다. */
export function acquireWriterLease(overrides: Partial<WriterLeaseDeps> = {}): WriterLeaseResult {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const lockPath = deps.lockPath();
  // LensStore.open()은 최초 save() 전까지 ~/.mcplens를 만들지 않으므로 락 자리를 먼저 보장한다.
  deps.ensureDir(dirname(lockPath));

  let lease = deps.acquire(lockPath, deps.ttlMs);
  if (!lease) return { ok: false, message: LEASE_BUSY_MESSAGE };

  let timer: unknown = deps.setInterval(() => {
    if (!lease) return;
    const renewed = deps.renew(lockPath, lease.token, deps.ttlMs);
    lease = renewed; // null이면 인수당한 것 → 즉시 비홀더가 되어 write guard가 save를 막는다
    if (!renewed) stopTimer();
  }, deps.renewMs);

  function stopTimer(): void {
    if (timer !== undefined) { deps.clearInterval(timer); timer = undefined; }
  }

  return {
    ok: true,
    lease: {
      isHolder: () => lease !== null,
      release: () => {
        stopTimer();
        if (lease) { deps.release(lockPath, lease.token); lease = null; }
      },
    },
  };
}

/**
 * 리스를 잡고 body를 실행한 뒤 반드시 해제한다(예외 경로 포함).
 * 획득 실패면 body를 아예 실행하지 않는다 — DB를 열지도 않는다는 뜻이다.
 */
export async function withWriterLease<T>(
  body: (lease: WriterLeaseHandle) => Promise<T>,
  overrides: Partial<WriterLeaseDeps> = {},
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const acquired = acquireWriterLease(overrides);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, value: await body(acquired.lease) };
  } finally {
    acquired.lease.release();
  }
}
