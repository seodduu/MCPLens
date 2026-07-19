import { mkdtempSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadStoredOAuth,
  saveStoredOAuth,
  clearStoredOAuth,
  storedTokenProvider,
  startCallbackServer,
  type StoredOAuth,
} from '../../src/scanner/oauth.js';

describe('oauth token store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcplens-oauth-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sample: StoredOAuth = {
    serverName: 'vercel',
    serverUrl: 'https://mcp.vercel.com',
    clientInformation: { client_id: 'abc123' },
    tokens: { access_token: 'tok', token_type: 'bearer' },
    updatedAt: '2026-07-20T00:00:00.000Z',
  };

  it('roundtrips saved data', () => {
    saveStoredOAuth(sample, dir);
    const loaded = loadStoredOAuth('vercel', dir);
    expect(loaded).toEqual(sample);
  });

  it('returns null for missing server', () => {
    expect(loadStoredOAuth('nope', dir)).toBeNull();
  });

  it('writes the token file with mode 0600', () => {
    saveStoredOAuth(sample, dir);
    const file = path.join(dir, 'vercel.json');
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tightens a pre-existing looser-permission base dir to 0700', () => {
    chmodSync(dir, 0o755);
    saveStoredOAuth(sample, dir);
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('clears a stored server', () => {
    saveStoredOAuth(sample, dir);
    clearStoredOAuth('vercel', dir);
    expect(loadStoredOAuth('vercel', dir)).toBeNull();
    expect(existsSync(path.join(dir, 'vercel.json'))).toBe(false);
  });

  it('clearing a missing server does not throw', () => {
    expect(() => clearStoredOAuth('ghost', dir)).not.toThrow();
  });

  it('does not escape the base dir via server name', () => {
    saveStoredOAuth({ ...sample, serverName: '../evil' }, dir);
    // whatever the sanitized name, the file must live inside dir
    const outside = path.join(path.dirname(dir), 'evil.json');
    expect(existsSync(outside)).toBe(false);
  });
});

describe('storedTokenProvider', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcplens-oauth-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = { name: 'vercel', url: 'https://mcp.vercel.com' };

  it('returns null when no tokens are stored', () => {
    expect(storedTokenProvider(spec, dir)).toBeNull();
  });

  it('returns null for non-http specs', () => {
    saveStoredOAuth(
      { serverName: 'x', serverUrl: '', tokens: { access_token: 't', token_type: 'bearer' }, updatedAt: '' },
      dir,
    );
    expect(storedTokenProvider({ name: 'x', command: 'node' }, dir)).toBeNull();
  });

  it('exposes stored tokens and client information', async () => {
    saveStoredOAuth(
      {
        serverName: 'vercel',
        serverUrl: 'https://mcp.vercel.com',
        clientInformation: { client_id: 'cid' },
        tokens: { access_token: 'tok', token_type: 'bearer' },
        updatedAt: '',
      },
      dir,
    );
    const provider = storedTokenProvider(spec, dir);
    expect(provider).not.toBeNull();
    expect(await provider!.tokens()).toEqual({ access_token: 'tok', token_type: 'bearer' });
    expect(await provider!.clientInformation()).toEqual({ client_id: 'cid' });
  });

  it('throws from redirectToAuthorization (scan stays non-interactive)', async () => {
    saveStoredOAuth(
      { serverName: 'vercel', serverUrl: 'https://mcp.vercel.com', tokens: { access_token: 't', token_type: 'bearer' }, updatedAt: '' },
      dir,
    );
    const provider = storedTokenProvider(spec, dir)!;
    await expect(
      Promise.resolve().then(() => provider.redirectToAuthorization(new URL('https://auth.example/authorize'))),
    ).rejects.toThrow();
  });
});

describe('startCallbackServer', () => {
  it('delivers the authorization code from the redirect', async () => {
    const cb = await startCallbackServer();
    try {
      const res = await fetch(`http://127.0.0.1:${cb.port}/callback?code=abc&state=xyz`);
      expect(res.status).toBe(200);
      const code = await cb.waitForCode(2000);
      expect(code).toBe('abc');
    } finally {
      cb.server.close();
    }
  });

  it('rejects when the redirect carries an error', async () => {
    const cb = await startCallbackServer();
    try {
      await fetch(`http://127.0.0.1:${cb.port}/callback?error=access_denied`);
      await expect(cb.waitForCode(2000)).rejects.toThrow();
    } finally {
      cb.server.close();
    }
  });

  it('times out when no callback arrives', async () => {
    const cb = await startCallbackServer();
    try {
      await expect(cb.waitForCode(50)).rejects.toThrow(/timeout/i);
    } finally {
      cb.server.close();
    }
  });
});
