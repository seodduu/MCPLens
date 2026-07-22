export type LeaseMode = 'writer' | 'read-only';

export function chooseMode(acquired: boolean): LeaseMode {
  return acquired ? 'writer' : 'read-only';
}
