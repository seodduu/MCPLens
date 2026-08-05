import os from 'node:os';
import path from 'node:path';
import type { ClientId } from './types.js';

export function lensHome(): string {
  return path.join(os.homedir(), '.mcplens');
}
export function dbPath(): string {
  return path.join(lensHome(), 'lens.db');
}
export function inboxPath(): string {
  return path.join(lensHome(), 'inbox');
}
/** Directory storing OAuth tokens and client registrations (file mode 0600). */
export function oauthDir(): string {
  return path.join(lensHome(), 'oauth');
}
export function dbWriterLockPath(home: string = os.homedir()): string {
  return path.join(home, '.mcplens', 'db-writer.lock');
}
export function clientLogRoots(client: ClientId): string[] {
  const h = os.homedir();
  switch (client) {
    case 'claude-code': return [path.join(h, '.claude', 'projects')];
    case 'codex':       return [path.join(h, '.codex', 'sessions')];
    case 'gemini-cli':  return [path.join(h, '.gemini', 'tmp')];
  }
}
