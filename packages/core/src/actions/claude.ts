import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GlobalAction } from '../types.js';
import { fingerprint } from './fingerprint.js';

export interface ActionFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  mkdir(directoryPath: string): Promise<void>;
  fsync(filePath: string): Promise<void>;
  listFiles?(directoryPath: string): Promise<readonly string[]>;
  remove?(filePath: string): Promise<void>;
}

export interface ActionRequest {
  serverName: string;
  toolName: string;
  settingsPath: string;
  identityConflict?: boolean;
  now?: Date;
  /** The action ledger is used only to determine Claude's active restore basis. */
  actions?: readonly GlobalAction[];
}

export interface ActionMutation {
  status: 'applied' | 'restored' | 'unchanged' | 'conflict' | 'failed';
  rule: string;
  backupPath?: string;
  preFingerprint?: string;
  postFingerprint?: string;
  reason?: 'identity-conflict' | 'invalid-json' | 'user-owned-rule' | 'postcondition-failed' | 'restore-conflict';
}

type JsonObject = Record<string, unknown>;

export function claudeDenyRule(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

export async function applyClaudeGlobalDeny(request: ActionRequest, fs: ActionFileSystem): Promise<ActionMutation> {
  return withPathLease(request.settingsPath, () => applyClaudeGlobalDenyLocked(request, fs));
}

async function applyClaudeGlobalDenyLocked(request: ActionRequest, fs: ActionFileSystem): Promise<ActionMutation> {
  const rule = claudeDenyRule(request.serverName, request.toolName);
  if (request.identityConflict) return { status: 'conflict', rule, reason: 'identity-conflict' };

  let original: string;
  let settings: JsonObject;
  try {
    original = await fs.readFile(request.settingsPath);
    settings = parseObject(original);
  } catch {
    return { status: 'failed', rule, reason: 'invalid-json' };
  }

  const deny = readDeny(settings);
  if (deny === null) return { status: 'failed', rule, reason: 'invalid-json' };
  if (deny.includes(rule)) return { status: 'unchanged', rule, reason: 'user-owned-rule' };

  const next = appendRule(settings, rule);
  const rendered = render(next);
  const backupPath = makeBackupPath(request.settingsPath, request.now ?? new Date());
  const preFingerprint = fingerprint(original);

  try {
    await fs.mkdir(path.dirname(request.settingsPath));
    await fs.copyFile(request.settingsPath, backupPath);
    if (!await writeAtomically(request.settingsPath, rendered, preFingerprint, fs)) {
      return { status: 'failed', rule, backupPath, preFingerprint, reason: 'postcondition-failed' };
    }
    const written = await fs.readFile(request.settingsPath);
    if (!readDeny(parseObject(written))?.includes(rule)) {
      return { status: 'failed', rule, backupPath, preFingerprint, reason: 'postcondition-failed' };
    }
    await trimCompletedBackups(request.settingsPath, backupPath, request.actions ?? [], fs);
    return { status: 'applied', rule, backupPath, preFingerprint, postFingerprint: fingerprint(written) };
  } catch {
    return { status: 'failed', rule, backupPath, preFingerprint };
  }
}

export async function restoreClaudeGlobalDeny(action: GlobalAction, fs: ActionFileSystem): Promise<ActionMutation> {
  let settingsPath: string;
  try {
    settingsPath = settingsPathFromBackup(action.backupPath);
  } catch {
    return restoreConflict(action);
  }
  return withPathLease(settingsPath, () => restoreClaudeGlobalDenyLocked(action, settingsPath, fs));
}

async function restoreClaudeGlobalDenyLocked(action: GlobalAction, settingsPath: string, fs: ActionFileSystem): Promise<ActionMutation> {
  let current: string;
  let before: JsonObject;
  let expectedBefore: JsonObject;
  try {
    current = await fs.readFile(settingsPath);
    before = parseObject(current);
    expectedBefore = parseObject(await fs.readFile(action.backupPath));
  } catch {
    return { status: 'conflict', rule: action.ownedRule, backupPath: action.backupPath, reason: 'restore-conflict' };
  }

  const currentDeny = readDeny(before);
  if (currentDeny === null || !currentDeny.includes(action.ownedRule) || !canRestore(current, action, before, expectedBefore)) {
    return { status: 'conflict', rule: action.ownedRule, backupPath: action.backupPath, reason: 'restore-conflict' };
  }

  const next = removeRule(before, action.ownedRule);
  try {
    if (!await writeAtomically(settingsPath, render(next), fingerprint(current), fs)) return restoreConflict(action);
    const written = await fs.readFile(settingsPath);
    if (readDeny(parseObject(written))?.includes(action.ownedRule)) {
      return { status: 'failed', rule: action.ownedRule, backupPath: action.backupPath, reason: 'postcondition-failed' };
    }
    return {
      status: 'restored', rule: action.ownedRule, backupPath: action.backupPath,
      preFingerprint: fingerprint(current), postFingerprint: fingerprint(written),
    };
  } catch {
    return { status: 'failed', rule: action.ownedRule, backupPath: action.backupPath };
  }
}

function parseObject(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('settings must be an object');
  return parsed as JsonObject;
}

function readDeny(settings: JsonObject): string[] | null {
  const permissions = settings.permissions;
  if (permissions === undefined) return [];
  if (permissions === null || Array.isArray(permissions) || typeof permissions !== 'object') return null;
  const deny = (permissions as JsonObject).deny;
  if (deny === undefined) return [];
  return Array.isArray(deny) && deny.every((value) => typeof value === 'string') ? [...deny] as string[] : null;
}

function appendRule(settings: JsonObject, rule: string): JsonObject {
  const permissions = settings.permissions;
  const nextPermissions: JsonObject = permissions !== undefined ? { ...(permissions as JsonObject) } : {};
  nextPermissions.deny = [...(readDeny(settings) ?? []), rule];
  return { ...settings, permissions: nextPermissions };
}

function removeRule(settings: JsonObject, rule: string): JsonObject {
  const nextPermissions = { ...(settings.permissions as JsonObject) };
  nextPermissions.deny = (readDeny(settings) ?? []).filter((value) => value !== rule);
  return { ...settings, permissions: nextPermissions };
}

function render(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAtomically(settingsPath: string, content: string, expectedFingerprint: string, fs: ActionFileSystem): Promise<boolean> {
  const temporaryPath = `${settingsPath}.mcplens.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, content);
    await fs.fsync(temporaryPath);
    parseObject(content);
    if (fingerprint(await fs.readFile(settingsPath)) !== expectedFingerprint) {
      await removeTemporary(temporaryPath, fs);
      return false;
    }
    await fs.rename(temporaryPath, settingsPath);
    return true;
  } catch (error) {
    await removeTemporary(temporaryPath, fs);
    throw error;
  }
}

function makeBackupPath(settingsPath: string, now: Date): string {
  return `${settingsPath}.mcplens-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`;
}

function settingsPathFromBackup(backupPath: string): string {
  const suffix = /\.mcplens-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]+\.bak$/;
  if (!suffix.test(backupPath)) throw new Error('unrecognized Claude backup path');
  return backupPath.replace(suffix, '');
}

const pathLeases = new Map<string, Promise<void>>();

async function withPathLease<T>(settingsPath: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLeases.get(settingsPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  pathLeases.set(settingsPath, tail);
  await previous.catch(() => undefined);
  try { return await task(); } finally {
    release();
    if (pathLeases.get(settingsPath) === tail) pathLeases.delete(settingsPath);
  }
}

async function removeTemporary(filePath: string, fs: ActionFileSystem): Promise<void> {
  try { await fs.remove?.(filePath); } catch { /* A cleanup failure must not mask the protected result. */ }
}

function restoreConflict(action: GlobalAction): ActionMutation {
  return { status: 'conflict', rule: action.ownedRule, backupPath: action.backupPath, reason: 'restore-conflict' };
}

function canRestore(current: string, action: GlobalAction, currentValue: JsonObject, originalValue: JsonObject): boolean {
  if (fingerprint(current) === action.postFingerprint) return true;
  return semanticEqual(removeRule(currentValue, action.ownedRule), originalValue);
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => semanticEqual(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftObject = left as JsonObject;
    const rightObject = right as JsonObject;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && semanticEqual(leftObject[key], rightObject[key]));
  }
  return false;
}

async function trimCompletedBackups(settingsPath: string, newestBackup: string, actions: readonly GlobalAction[], fs: ActionFileSystem): Promise<void> {
  if (fs.listFiles === undefined || fs.remove === undefined) return;
  const prefix = `${path.basename(settingsPath)}.mcplens-`;
  const backups = (await fs.listFiles(path.dirname(settingsPath)))
    .filter((file) => path.basename(file).startsWith(prefix) && file.endsWith('.bak'))
    .sort();
  const protectedSet = new Set([
    newestBackup,
    ...actions
      .filter((action) => action.client === 'claude-code' && isProtectedActionStatus(action.status))
      .map((action) => action.backupPath),
  ]);
  const removable = backups.filter((file) => !protectedSet.has(file));
  const completedToKeep = Math.max(0, 5 - [...protectedSet].filter((file) => backups.includes(file)).length);
  for (const file of removable.slice(0, Math.max(0, removable.length - completedToKeep))) await fs.remove(file);
}

function isProtectedActionStatus(status: GlobalAction['status']): boolean {
  return status === 'active' || status === 'restore-pending' || status === 'conflict';
}
