import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
// -- Low-level parts moved here (installLease/readLease/takeOverLease/lockInstanceToken/reapingPath/isBusy/isCode) --
// Moved verbatim from inbox.ts. Only the LockLease type was renamed to Lease.
export function installLease(lockPath, lease) {
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
export function readLease(lockPath) {
    const owner = readOwner(lockPath);
    if (!owner)
        return owner;
    // Identity (token) always comes from owner.json. Expiry (expiresAt) lives in a separate sidecar (expiry.json) that
    // is applied only when it exists and its token matches the owner's token (marking it as renew's own).
    const expiry = readExpiry(lockPath);
    return expiry && expiry.token === owner.token
        ? { token: owner.token, expiresAt: expiry.expiresAt }
        : owner;
}
/** Identity lease decided by owner.json alone. The expiry sidecar is not consulted. */
function readOwner(lockPath) {
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
/** Reads the expiry sidecar. null when missing or malformed (= use the owner.json expiry). */
function readExpiry(lockPath) {
    try {
        const raw = readFileSync(join(lockPath, 'expiry.json'), 'utf8');
        const value = JSON.parse(raw);
        return typeof value.token === 'string' && typeof value.expiresAt === 'number'
            ? { token: value.token, expiresAt: value.expiresAt }
            : null;
    }
    catch {
        return null;
    }
}
function lockInstanceToken(lockPath, content) {
    const stat = statSync(lockPath);
    return createHash('sha256')
        .update(`${stat.ino}:${stat.ctimeMs}:${stat.birthtimeMs}:${content}`)
        .digest('hex');
}
export function reapingPath(lockPath, token) {
    return `${lockPath}.reaping-${createHash('sha256').update(token).digest('hex')}`;
}
/**
 * Removes reaping debris next to the lock directory.
 *
 * A reaping name exists only after the lock was renamed to it, which means it is already not an
 * active lease. A failed removal is ignored: it just means another process is clearing the same
 * debris. Returns how many were removed.
 */
export function sweepReapingDirs(directory) {
    let removed = 0;
    let entries;
    try {
        entries = readdirSync(directory);
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.includes('.reaping-'))
            continue;
        try {
            rmSync(join(directory, entry), { recursive: true, force: true });
            removed += 1;
        }
        catch { /* a competitor cleared it first, or a permission issue; the debris is harmless, so move on */ }
    }
    return removed;
}
export function takeOverLease(lockPath, token) {
    const reaping = reapingPath(lockPath, token);
    try {
        renameSync(lockPath, reaping);
    }
    catch (error) {
        if (isBusy(error) || isCode(error, 'ENOENT'))
            return false;
        throw error;
    }
    rmSync(reaping, { recursive: true, force: true });
    return true;
}
export function isCode(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error
        && error.code === code;
}
export function isBusy(error) {
    return isCode(error, 'EEXIST') || isCode(error, 'ENOTEMPTY');
}
/** One attempt: install, or take over an expired lease and then install. null when a valid holder exists. */
export function acquireLease(lockPath, ttlMs, nowMs = () => Date.now()) {
    // Debris from a previous run that died between rename and rm is reclaimed here.
    sweepReapingDirs(dirname(lockPath));
    const now = nowMs();
    const lease = { token: randomUUID(), expiresAt: now + ttlMs };
    if (installLease(lockPath, lease))
        return lease;
    const current = readLease(lockPath);
    if (current && current.expiresAt <= now && takeOverLease(lockPath, current.token)) {
        const retry = { token: randomUUID(), expiresAt: nowMs() + ttlMs };
        if (installLease(lockPath, retry))
            return retry;
    }
    return null;
}
/**
 * Extends the expiry if I am still the holder. null if taken over.
 *
 * RACE-FREE invariant (identity/expiry split):
 * renew never touches owner.json, the source of identity, and atomically writes the sidecar
 * expiry.json ({token, expiresAt}) with tmp+rename. Even if competitor B takes over with
 * takeOverLease+installLease between the check (readLease) and the write:
 *  - B's owner.json is never written by renew, so identity cannot be corrupted.
 *  - the token (A) in the expiry.json A wrote does not match B's owner token, so readLease ignores it (B's expiry is safe too).
 *  - on the re-check after the write the owner token is B, so A gets null (A lost).
 * additive & inbox-inert: inbox never calls renew, so expiry.json is absent and readLease behaves unchanged.
 *
 * hooks.beforeWrite is a test-only seam called right after the check and right before the write (to reproduce the race).
 * WriterLeaseManager does not pass this argument, so it is harmless.
 */
export function renewLease(lockPath, token, ttlMs, nowMs = () => Date.now(), hooks) {
    const current = readLease(lockPath);
    if (!current || current.token !== token)
        return null;
    hooks?.beforeWrite?.();
    const sidecar = { token, expiresAt: nowMs() + ttlMs };
    const tmp = join(lockPath, `.expiry.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmp, JSON.stringify(sidecar), { mode: 0o600 });
        renameSync(tmp, join(lockPath, 'expiry.json'));
    }
    catch (error) {
        try {
            rmSync(tmp, { force: true });
        }
        catch { /* ignore */ }
        if (isCode(error, 'ENOENT'))
            return null; // the lock directory vanished (taken over)
        throw error;
    }
    const after = readLease(lockPath);
    return after && after.token === token ? after : null;
}
/** Releases only when the token is mine, and cleans up the traces. */
export function releaseLease(lockPath, token) {
    if (readLease(lockPath)?.token !== token)
        return;
    const reaping = reapingPath(lockPath, token);
    try {
        renameSync(lockPath, reaping);
        rmSync(reaping, { recursive: true, force: true });
    }
    catch (error) {
        if (!isCode(error, 'ENOENT') && !isBusy(error))
            throw error;
    }
}
//# sourceMappingURL=lease.js.map