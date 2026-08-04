import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import type { GlobalAction } from '../types.js';
import { fingerprint } from './fingerprint.js';
import type { ActionFileSystem, ActionMutation, ActionRequest } from './claude.js';
import { patchDisabledTools } from './tomlArrayPatch.js';

export async function applyCodexDisabledTool(request: ActionRequest, fs: ActionFileSystem): Promise<ActionMutation> {
  return withPathLease(request.settingsPath, () => applyCodexDisabledToolLocked(request, fs));
}

async function applyCodexDisabledToolLocked(request: ActionRequest, fs: ActionFileSystem): Promise<ActionMutation> {
  const rule = request.toolName;
  if (request.identityConflict) return { status: 'conflict', rule, reason: 'identity-conflict' };
  let original: string;
  try { original = await fs.readFile(request.settingsPath); } catch { return { status: 'failed', rule, reason: 'invalid-json' }; }
  const patch = patchDisabledTools(original, request.serverName, rule);
  if (patch.status === 'invalid') return { status: 'failed', rule, reason: 'invalid-json' };
  if (patch.status === 'unchanged') return { status: 'unchanged', rule, reason: 'user-owned-rule' };

  const backupPath = makeBackupPath(request.settingsPath, request.now ?? new Date());
  const preFingerprint = fingerprint(original);
  try {
    await fs.mkdir(path.dirname(request.settingsPath));
    await fs.copyFile(request.settingsPath, backupPath);
    if (!await writeAtomically(request.settingsPath, patch.value, preFingerprint, fs)) {
      return { status: 'failed', rule, backupPath, preFingerprint, reason: 'postcondition-failed' };
    }
    const written = await fs.readFile(request.settingsPath);
    if (patchDisabledTools(written, request.serverName, rule).status !== 'unchanged') {
      return { status: 'failed', rule, backupPath, preFingerprint, reason: 'postcondition-failed' };
    }
    await trimCompletedBackups(request.settingsPath, backupPath, request.actions ?? [], fs);
    return { status: 'applied', rule, backupPath, preFingerprint, postFingerprint: fingerprint(written) };
  } catch {
    return { status: 'failed', rule, backupPath, preFingerprint };
  }
}

export async function restoreCodexDisabledTool(action: GlobalAction, fs: ActionFileSystem): Promise<ActionMutation> {
  let settingsPath: string;
  try { settingsPath = settingsPathFromBackup(action.backupPath); } catch { return restoreConflict(action); }
  return withPathLease(settingsPath, () => restoreCodexDisabledToolLocked(action, settingsPath, fs));
}

async function restoreCodexDisabledToolLocked(action: GlobalAction, settingsPath: string, fs: ActionFileSystem): Promise<ActionMutation> {
  let current: string;
  let original: string;
  try {
    current = await fs.readFile(settingsPath);
    original = await fs.readFile(action.backupPath);
  } catch {
    return restoreConflict(action);
  }
  const shouldKeepEmpty = originalHasDisabledTools(original, action.serverName);
  const patch = patchDisabledTools(current, action.serverName, action.ownedRule, 'remove', shouldKeepEmpty);
  if (patch.status !== 'patched' || !canRestore(current, action, patch.value, original)) return restoreConflict(action);
  try {
    if (!await writeAtomically(settingsPath, patch.value, fingerprint(current), fs)) return restoreConflict(action);
    const written = await fs.readFile(settingsPath);
    if (patchDisabledTools(written, action.serverName, action.ownedRule, 'add').status !== 'patched') {
      return { status: 'failed', rule: action.ownedRule, backupPath: action.backupPath, reason: 'postcondition-failed' };
    }
    return { status: 'restored', rule: action.ownedRule, backupPath: action.backupPath, preFingerprint: fingerprint(current), postFingerprint: fingerprint(written) };
  } catch {
    return { status: 'failed', rule: action.ownedRule, backupPath: action.backupPath };
  }
}

async function writeAtomically(settingsPath: string, content: string, expectedFingerprint: string, fs: ActionFileSystem): Promise<boolean> {
  const temporaryPath = `${settingsPath}.mcplens.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, content);
    await fs.fsync(temporaryPath);
    parseToml(content.replace(/^\uFEFF/, ''));
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
  if (!suffix.test(backupPath)) throw new Error('unrecognized Codex backup path');
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
  try { await fs.remove?.(filePath); } catch { /* cleanup failure must not hide the guarded outcome */ }
}

function originalHasDisabledTools(source: string, serverName: string): boolean {
  try {
    const parsed = parseToml(source.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
    const table = servers?.[serverName] as Record<string, unknown> | undefined;
    return table !== undefined && Object.hasOwn(table, 'disabled_tools');
  } catch { return true; }
}

function canRestore(current: string, action: GlobalAction, withoutOwnedRule: string, original: string): boolean {
  return fingerprint(current) === action.postFingerprint || semanticTomlEqual(withoutOwnedRule, original);
}

function semanticTomlEqual(left: string, right: string): boolean {
  try { return semanticEqual(parseToml(left.replace(/^\uFEFF/, '')), parseToml(right.replace(/^\uFEFF/, ''))); } catch { return false; }
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => semanticEqual(item, right[index]));
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && semanticEqual(leftObject[key], rightObject[key]));
  }
  return false;
}

function restoreConflict(action: GlobalAction): ActionMutation {
  return { status: 'conflict', rule: action.ownedRule, backupPath: action.backupPath, reason: 'restore-conflict' };
}

async function trimCompletedBackups(settingsPath: string, newestBackup: string, actions: readonly GlobalAction[], fs: ActionFileSystem): Promise<void> {
  if (fs.listFiles === undefined || fs.remove === undefined) return;
  const prefix = `${path.basename(settingsPath)}.mcplens-`;
  const backups = (await fs.listFiles(path.dirname(settingsPath))).filter((file) => path.basename(file).startsWith(prefix) && file.endsWith('.bak')).sort();
  const protectedSet = new Set([newestBackup, ...actions.filter((action) => action.client === 'codex' && (action.status === 'active' || action.status === 'restore-pending' || action.status === 'conflict')).map((action) => action.backupPath)]);
  const removable = backups.filter((file) => !protectedSet.has(file));
  const completedToKeep = Math.max(0, 5 - [...protectedSet].filter((file) => backups.includes(file)).length);
  for (const file of removable.slice(0, Math.max(0, removable.length - completedToKeep))) await fs.remove(file);
}
