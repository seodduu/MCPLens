import { createHash } from 'node:crypto';

/** 설정 파일 원문을 감사하기 위한 SHA-256 fingerprint. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
