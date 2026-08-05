import { createHash } from 'node:crypto';

/** SHA-256 fingerprint used to audit the raw config file. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
