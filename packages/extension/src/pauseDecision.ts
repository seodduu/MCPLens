import type { LeaseMode } from './leaseMode.js';

export type CollectAction = 'start' | 'stop';

/**
 * 훅 pending 감시를 켤지 끌지 결정한다.
 * writer이면서 중지 상태가 아닐 때만 감시한다 — read-only 홀더는 DB에 쓸 수 없고,
 * 중지 상태는 리스 승격보다 우선한다(사용자의 명시적 의사).
 */
export function collectAction(paused: boolean, mode: LeaseMode): CollectAction {
  if (paused) return 'stop';
  return mode === 'writer' ? 'start' : 'stop';
}
