import { acquireLease, renewLease, releaseLease, type Lease } from '@mcp-lens/core';

interface LeaseDeps {
  acquire: (lockPath: string, ttlMs: number) => Lease | null;
  renew: (lockPath: string, token: string, ttlMs: number) => Lease | null;
  release: (lockPath: string, token: string) => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (h: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_DEPS: LeaseDeps = {
  acquire: acquireLease, renew: renewLease, release: releaseLease,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export class WriterLeaseManager {
  private lease: Lease | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly deps: LeaseDeps;

  constructor(private lockPath: string, opts: { ttlMs?: number; renewMs?: number; deps?: LeaseDeps } = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.renewMs = opts.renewMs ?? 10_000;
    this.deps = opts.deps ?? DEFAULT_DEPS;
  }

  tryAcquire(): boolean {
    this.lease = this.deps.acquire(this.lockPath, this.ttlMs);
    return this.lease !== null;
  }

  isHolder(): boolean { return this.lease !== null; }

  startHeartbeat(onLost: () => void): void {
    if (this.timer) return;
    this.timer = this.deps.setInterval(() => {
      if (!this.lease) return;
      // A renew that throws (EACCES and friends) counts as a failed renewal. Letting the exception
      // escape the interval callback would leave this.lease set, keeping isHolder() true, and once the
      // TTL passed and another window took the lease there would be two writers and lost writes.
      let renewed: Lease | null = null;
      try {
        renewed = this.deps.renew(this.lockPath, this.lease.token, this.ttlMs);
      } catch {
        renewed = null;
      }
      if (renewed) { this.lease = renewed; return; }
      this.lease = null;           // taken over: immediately a non-holder
      this.stopTimer();
      onLost();
    }, this.renewMs);
  }

  private stopTimer(): void {
    if (this.timer) { this.deps.clearInterval(this.timer); this.timer = null; }
  }

  stop(): void {
    this.stopTimer();
    if (this.lease) { this.deps.release(this.lockPath, this.lease.token); this.lease = null; }
  }
}
