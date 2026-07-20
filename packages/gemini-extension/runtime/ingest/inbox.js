import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
/** Exceeds the two-second hook budget while still guaranteeing eventual takeover. */
const LOCK_LEASE_MS = 5_000;
const LOCK_WAIT_MS = LOCK_LEASE_MS + 100;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
export class InboxLockBusyError extends Error {
    code = 'INBOX_LOCK_BUSY';
    constructor(deliveryId) {
        super(`Inbox delivery lock is busy; retry ${deliveryId}`);
        this.name = 'InboxLockBusyError';
    }
}
export function inboxPaths(opts = {}) {
    const root = opts.root ?? join(homedir(), '.mcplens', 'inbox');
    const paths = {
        root,
        pending: join(root, 'pending'),
        processed: join(root, 'processed'),
        locks: join(root, '.locks'),
    };
    secureDirectory(paths.root);
    secureDirectory(paths.pending);
    secureDirectory(paths.processed);
    secureDirectory(paths.locks);
    return paths;
}
export function enqueueEnvelope(env, opts = {}) {
    const deliveryId = checkedDeliveryId(env.deliveryId);
    const paths = inboxPaths(opts);
    const finalPath = join(paths.pending, `${deliveryId}.json`);
    const committedPath = join(paths.locks, `${deliveryId}.committed`);
    if (existsSync(finalPath))
        return 'duplicate';
    const lockPath = join(paths.locks, `${deliveryId}.lock`);
    const lease = acquireDeliveryLock(lockPath, opts);
    if (!lease)
        return 'duplicate';
    const now = (opts.now ?? (() => new Date()))();
    let tempPath;
    let uniqueCommit;
    try {
        if (existsSync(committedPath)) {
            if (deliveryExists(paths, deliveryId))
                return 'duplicate';
            try {
                linkSync(committedPath, finalPath);
                return 'queued';
            }
            catch (error) {
                if (isCode(error, 'EEXIST'))
                    return 'duplicate';
                throw error;
            }
        }
        if (deliveryExists(paths, deliveryId))
            return 'duplicate';
        const serialized = serializeEnvelope(env);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) {
            throw new RangeError('Hook envelope exceeds the 1 MiB inbox limit');
        }
        tempPath = join(paths.pending, `.${deliveryId}.${process.pid}.${now.getTime()}.tmp`);
        const fd = openSync(tempPath, 'wx', 0o600);
        try {
            writeFileSync(fd, serialized, 'utf8');
        }
        finally {
            closeSync(fd);
        }
        uniqueCommit = join(paths.locks, `${deliveryId}.commit-${lease.token}`);
        renameSync(tempPath, uniqueCommit);
        tempPath = undefined;
        chmodSync(uniqueCommit, 0o600);
        try {
            linkSync(uniqueCommit, committedPath);
        }
        catch (error) {
            if (isCode(error, 'EEXIST'))
                return 'duplicate';
            throw error;
        }
        try {
            linkSync(committedPath, finalPath);
        }
        catch (error) {
            if (isCode(error, 'EEXIST'))
                return 'duplicate';
            throw error;
        }
        return 'queued';
    }
    finally {
        if (tempPath && existsSync(tempPath))
            unlinkSync(tempPath);
        if (uniqueCommit && existsSync(uniqueCommit))
            unlinkSync(uniqueCommit);
        releaseDeliveryLock(lockPath, lease.token);
    }
}
function deliveryExists(paths, deliveryId) {
    return existsSync(join(paths.pending, `${deliveryId}.json`))
        || existsSync(join(paths.pending, `${deliveryId}.processing`))
        || existsSync(join(paths.processed, `${deliveryId}.json`));
}
function acquireDeliveryLock(lockPath, opts, wait = false) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
        const now = (opts.now ?? (() => new Date()))().getTime();
        const lease = { token: randomUUID(), expiresAt: now + LOCK_LEASE_MS };
        if (installLease(lockPath, lease))
            return lease;
        const current = readLease(lockPath);
        if (current && current.expiresAt <= now && takeOverLease(lockPath, current.token))
            continue;
        if (!wait || opts.now || Date.now() >= deadline)
            return null;
        Atomics.wait(WAIT_BUFFER, 0, 0, 5);
    }
}
function installLease(lockPath, lease) {
    const candidate = `${lockPath}.candidate-${lease.token}`;
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, 'owner.json'), JSON.stringify(lease), { mode: 0o600 });
    try {
        renameSync(candidate, lockPath);
        return true;
    }
    catch (error) {
        rmSync(candidate, { recursive: true, force: true });
        if (isBusy(error))
            return false;
        throw error;
    }
}
function readLease(lockPath) {
    try {
        const raw = readFileSync(join(lockPath, 'owner.json'), 'utf8');
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch {
            return { token: lockInstanceToken(lockPath, raw), expiresAt: 0 };
        }
        return typeof value.token === 'string' && typeof value.expiresAt === 'number'
            ? { token: value.token, expiresAt: value.expiresAt }
            : { token: lockInstanceToken(lockPath, raw), expiresAt: 0 };
    }
    catch (error) {
        if (isCode(error, 'ENOENT')) {
            return existsSync(lockPath) ? { token: lockInstanceToken(lockPath, ''), expiresAt: 0 } : null;
        }
        throw error;
    }
}
function lockInstanceToken(lockPath, content) {
    const stat = statSync(lockPath);
    return createHash('sha256')
        .update(`${stat.ino}:${stat.ctimeMs}:${stat.birthtimeMs}:${content}`)
        .digest('hex');
}
function reapingPath(lockPath, token) {
    return `${lockPath}.reaping-${createHash('sha256').update(token).digest('hex')}`;
}
function takeOverLease(lockPath, token) {
    const reaping = reapingPath(lockPath, token);
    try {
        renameSync(lockPath, reaping);
        return true;
    }
    catch (error) {
        if (isBusy(error) || isCode(error, 'ENOENT'))
            return false;
        throw error;
    }
}
function releaseDeliveryLock(lockPath, token) {
    if (readLease(lockPath)?.token !== token)
        return;
    const reaping = reapingPath(lockPath, token);
    try {
        renameSync(lockPath, reaping);
    }
    catch (error) {
        if (!isBusy(error) && !isCode(error, 'ENOENT'))
            throw error;
    }
}
export function claimPending(opts = {}) {
    const paths = inboxPaths(opts);
    const now = (opts.now ?? (() => new Date()))();
    recoverStaleProcessing(paths, opts);
    const claims = [];
    let parseErrors = 0;
    for (const filename of readdirSync(paths.pending).filter((name) => name.endsWith('.json')).sort()) {
        const deliveryId = filename.slice(0, -'.json'.length);
        const pendingPath = join(paths.pending, filename);
        const processingPath = join(paths.pending, `${deliveryId}.processing`);
        const lockPath = join(paths.locks, `${deliveryId}.lock`);
        const lease = acquireDeliveryLock(lockPath, opts);
        if (!lease)
            continue;
        try {
            try {
                utimesSync(pendingPath, now, now);
                renameSync(pendingPath, processingPath);
            }
            catch (error) {
                if (isCode(error, 'ENOENT'))
                    continue;
                throw error;
            }
            try {
                const value = JSON.parse(readFileSync(processingPath, 'utf8'));
                if (!isHookEnvelope(value, deliveryId))
                    throw new InvalidEnvelopeError();
                claims.push({ deliveryId, envelope: value });
            }
            catch (error) {
                if (isCode(error, 'ENOENT'))
                    continue;
                if (!(error instanceof SyntaxError) && !(error instanceof InvalidEnvelopeError))
                    throw error;
                parseErrors += 1;
                unlinkSync(processingPath);
            }
        }
        finally {
            releaseDeliveryLock(lockPath, lease.token);
        }
    }
    Object.defineProperty(claims, 'parseErrors', { value: parseErrors, enumerable: false });
    return claims;
}
export function markProcessed(claim, opts = {}) {
    const deliveryId = checkedDeliveryId(claim.deliveryId);
    const paths = inboxPaths(opts);
    const lockPath = join(paths.locks, `${deliveryId}.lock`);
    const lease = acquireDeliveryLock(lockPath, opts, true);
    if (!lease)
        throw new InboxLockBusyError(deliveryId);
    const source = join(paths.pending, `${deliveryId}.processing`);
    const destination = join(paths.processed, `${deliveryId}.json`);
    try {
        renameSync(source, destination);
        chmodSync(destination, 0o600);
    }
    finally {
        releaseDeliveryLock(lockPath, lease.token);
    }
}
export function releaseClaim(claim, opts = {}) {
    const deliveryId = checkedDeliveryId(claim.deliveryId);
    const paths = inboxPaths(opts);
    const lockPath = join(paths.locks, `${deliveryId}.lock`);
    const lease = acquireDeliveryLock(lockPath, opts, true);
    if (!lease)
        throw new InboxLockBusyError(deliveryId);
    try {
        renameSync(join(paths.pending, `${deliveryId}.processing`), join(paths.pending, `${deliveryId}.json`));
    }
    finally {
        releaseDeliveryLock(lockPath, lease.token);
    }
}
function secureDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
}
function checkedDeliveryId(deliveryId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(deliveryId)) {
        throw new Error('Invalid inbox delivery id');
    }
    return deliveryId;
}
function serializeEnvelope(env) {
    const persisted = {
        schemaVersion: env.schemaVersion,
        deliveryId: env.deliveryId,
        client: env.client,
        phase: env.phase,
        receivedAt: env.receivedAt,
        externalSessionId: env.externalSessionId,
        externalTurnId: env.externalTurnId,
        externalCallId: env.externalCallId,
        transcriptPath: env.transcriptPath,
        serverName: env.serverName,
        toolName: env.toolName,
        observedAt: env.observedAt,
        durationMs: env.durationMs,
        isError: env.isError,
        inputFingerprint: env.inputFingerprint,
    };
    return JSON.stringify(persisted);
}
function recoverStaleProcessing(paths, opts) {
    const now = (opts.now ?? (() => new Date()))();
    for (const filename of readdirSync(paths.pending).filter((name) => name.endsWith('.processing'))) {
        const deliveryId = filename.slice(0, -'.processing'.length);
        const processingPath = join(paths.pending, filename);
        const lockPath = join(paths.locks, `${deliveryId}.lock`);
        const lease = acquireDeliveryLock(lockPath, opts);
        if (!lease)
            continue;
        try {
            if (now.getTime() - statSync(processingPath).mtimeMs < STALE_PROCESSING_MS)
                continue;
            const pendingPath = join(paths.pending, `${deliveryId}.json`);
            if (!existsSync(pendingPath))
                renameSync(processingPath, pendingPath);
        }
        catch (error) {
            if (!isCode(error, 'ENOENT'))
                throw error;
        }
        finally {
            releaseDeliveryLock(lockPath, lease.token);
        }
    }
}
class InvalidEnvelopeError extends Error {
}
const ENVELOPE_KEYS = [
    'schemaVersion', 'deliveryId', 'client', 'phase', 'receivedAt', 'externalSessionId',
    'externalTurnId', 'externalCallId', 'transcriptPath', 'serverName', 'toolName',
    'observedAt', 'durationMs', 'isError', 'inputFingerprint',
];
const CLIENTS = new Set(['claude-code', 'codex', 'gemini-cli']);
const PHASES = new Set(['session-start', 'tool-before', 'tool-after', 'tool-failure', 'turn-stop', 'session-end']);
function isHookEnvelope(value, deliveryId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const item = value;
    const keys = Object.keys(item);
    const nullableString = (field) => item[field] === null || typeof item[field] === 'string';
    return keys.length === ENVELOPE_KEYS.length && keys.every((key) => ENVELOPE_KEYS.includes(key))
        && item.schemaVersion === 1 && item.deliveryId === deliveryId
        && typeof item.deliveryId === 'string' && CLIENTS.has(String(item.client))
        && PHASES.has(String(item.phase)) && typeof item.receivedAt === 'string'
        && typeof item.externalSessionId === 'string' && nullableString('externalTurnId')
        && nullableString('externalCallId') && nullableString('transcriptPath')
        && nullableString('serverName') && nullableString('toolName')
        && typeof item.observedAt === 'string'
        && (item.durationMs === null || typeof item.durationMs === 'number')
        && (item.isError === null || typeof item.isError === 'boolean')
        && nullableString('inputFingerprint');
}
function isCode(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error
        && error.code === code;
}
function isBusy(error) {
    return isCode(error, 'EEXIST') || isCode(error, 'ENOTEMPTY');
}
//# sourceMappingURL=inbox.js.map