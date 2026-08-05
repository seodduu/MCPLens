import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { oauthDir } from '../paths.js';
import { specTransport, type McpServerSpec } from './configs.js';

/**
 * Disk representation of the OAuth credentials Lens itself was issued for one http MCP server.
 * Tokens stored by a client (Claude Code and friends) are never reused; Lens issues its own.
 */
export interface StoredOAuth {
  serverName: string;
  serverUrl: string;
  /** SDK dynamic client registration result (serialized OAuthClientInformationMixed) */
  clientInformation?: unknown;
  /** access/refresh tokens (serialized OAuthTokens) */
  tokens?: unknown;
  updatedAt: string;
}

/**
 * An OAuth client the user registered by hand on the provider's side, for servers that refuse
 * dynamic client registration (DCR). GitHub's remote MCP publishes no registration_endpoint at all,
 * and Figma publishes one that answers 403 to every request, so for those two the only way in is a
 * client id the user creates themselves.
 */
export interface PreregisteredClient {
  clientId: string;
  /** Public (PKCE-only) clients have none. */
  clientSecret?: string;
}

/** The file the CLI reads pre-registered clients from: ~/.mcplens/oauth-clients.json. */
export function oauthClientsFile(baseDir: string = oauthDir()): string {
  return path.join(baseDir, 'clients.json');
}

/**
 * Reads `{ "<serverName>": { "clientId": "...", "clientSecret": "..." } }`.
 * An unreadable or malformed file yields an empty map: a bad hand-edited file must not stop a login
 * that dynamic registration could have handled on its own.
 */
export function readOAuthClients(baseDir: string = oauthDir()): Record<string, PreregisteredClient> {
  const file = oauthClientsFile(baseDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, PreregisteredClient>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Writes one server's client into the shared file, keeping every other entry. Mode 0600: a client secret is a credential. */
export function saveOAuthClient(
  serverName: string, client: PreregisteredClient, baseDir: string = oauthDir()): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  chmodSync(baseDir, 0o700);
  const file = oauthClientsFile(baseDir);
  const all = { ...readOAuthClients(baseDir), [serverName]: client };
  writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Thrown when a login fails because the server would not register Lens as a client and no
 * pre-registered client was supplied. The host catches it by name to ask for a client id instead of
 * showing the raw SDK message, which says nothing about what the user should do.
 */
export class ClientRegistrationRequiredError extends Error {
  override readonly name = 'ClientRegistrationRequiredError';
  constructor(readonly serverName: string, readonly cause: string) {
    super(
      `${serverName} does not allow automatic client registration. ` +
      `Register an OAuth app with this provider and give MCP Lens its client id. (${cause})`);
  }
}

/**
 * Whether an SDK failure means "registration was refused". Registration is the only step that runs
 * before a browser is ever opened, so a 4xx from the first auth() pass with no client on hand is
 * always the registration endpoint answering. Figma's 403 arrives that way; GitHub fails earlier,
 * with the SDK's own message, because it publishes no registration endpoint at all.
 */
function isRegistrationFailure(message: string): boolean {
  return /dynamic client registration/i.test(message) || /HTTP 4\d\d/.test(message);
}

/** Converts a server name into a safe file name (guards against path escape). */
function safeFileName(serverName: string): string {
  const base = serverName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${base || '_'}.json`;
}

/** Reads ~/.mcplens/oauth/<serverName>.json. null when missing or unparsable. */
export function loadStoredOAuth(serverName: string, baseDir: string = oauthDir()): StoredOAuth | null {
  const file = path.join(baseDir, safeFileName(serverName));
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredOAuth;
  } catch {
    return null;
  }
}

/** Saves credentials with mode 0600 (plaintext; see the security note below). */
export function saveStoredOAuth(data: StoredOAuth, baseDir: string = oauthDir()): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode applies only on creation, so a directory that already existed with looser
  // permissions is forced with chmod too (same pattern as for the file).
  chmodSync(baseDir, 0o700);
  const file = path.join(baseDir, safeFileName(data.serverName));
  // writeFileSync's mode applies only on creation, so chmod forces it on an existing file too.
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Deletes the stored credentials (ignored when absent). */
export function clearStoredOAuth(serverName: string, baseDir: string = oauthDir()): void {
  const file = path.join(baseDir, safeFileName(serverName));
  rmSync(file, { force: true });
}

/**
 * SDK OAuthClientProvider implementation.
 * Tokens and client registration persist in the StoredOAuth file; the PKCE code verifier stays in
 * memory only (kept between the two auth() calls of one login flow, never written to disk).
 * Redirect handling (opening the browser) is delegated to the onRedirect callback the host injects.
 */
class LensOAuthProvider implements OAuthClientProvider {
  private _codeVerifier?: string;

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly _redirectUrl: string,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
    private readonly baseDir: string,
    /** Set only for servers that refuse DCR; it short-circuits registration entirely. */
    private readonly preregistered?: PreregisteredClient,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    // client_name = "MCP Lens" makes the server consent screen show Lens by name (credential principle).
    return {
      client_name: 'MCP Lens',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // A user-registered client wins over anything on disk: it is the newer decision, and returning
    // it here is what makes the SDK skip registration on servers that refuse it.
    if (this.preregistered) {
      return {
        client_id: this.preregistered.clientId,
        ...(this.preregistered.clientSecret ? { client_secret: this.preregistered.clientSecret } : {}),
      } as OAuthClientInformationMixed;
    }
    const stored = loadStoredOAuth(this.serverName, this.baseDir);
    return stored?.clientInformation as OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const prev = loadStoredOAuth(this.serverName, this.baseDir);
    saveStoredOAuth(
      {
        serverName: this.serverName,
        serverUrl: this.serverUrl,
        clientInformation: info,
        tokens: prev?.tokens,
        updatedAt: new Date().toISOString(),
      },
      this.baseDir,
    );
  }

  tokens(): OAuthTokens | undefined {
    const stored = loadStoredOAuth(this.serverName, this.baseDir);
    return stored?.tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    const prev = loadStoredOAuth(this.serverName, this.baseDir);
    saveStoredOAuth(
      {
        serverName: this.serverName,
        serverUrl: this.serverUrl,
        clientInformation: prev?.clientInformation,
        tokens,
        updatedAt: new Date().toISOString(),
      },
      this.baseDir,
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) throw new Error('code verifier is not set (authentication flow out of order)');
    return this._codeVerifier;
  }
}

/**
 * Non-interactive provider for an http spec that already has stored tokens.
 * null when there is no stored data or token, or when the spec is not http. redirectToAuthorization
 * throws immediately: a scan never opens a browser (the scan stays non-interactive).
 */
export function storedTokenProvider(
  spec: McpServerSpec,
  baseDir: string = oauthDir(),
): OAuthClientProvider | null {
  if (specTransport(spec) !== 'http') return null;
  const stored = loadStoredOAuth(spec.name, baseDir);
  if (!stored || !stored.tokens) return null;
  return new LensOAuthProvider(
    spec.name,
    spec.url!,
    'http://127.0.0.1/callback', // placeholder; no redirect happens during a scan
    () => {
      throw new Error(
        `auth-required: ${spec.name} needs a login (mcp-lens auth ${spec.name})`,
      );
    },
    baseDir,
  );
}

/** Callback server on an ephemeral 127.0.0.1 port. Exposes the authorization-code receiver for isolated testing. */
export interface CallbackServer {
  server: http.Server;
  port: number;
  /** Resolves with the code when /callback?code=... arrives within timeoutMs, otherwise rejects. */
  waitForCode(timeoutMs: number): Promise<string>;
}

export async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // The callback can arrive or fail before waitForCode is called, so attach a harmless handler
  // right away to keep a late rejection from leaking as an unhandled rejection.
  codePromise.catch(() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (code) {
      res.end(
        '<!doctype html><html lang="ko"><body style="font-family:sans-serif;text-align:center;padding:3rem">' +
          '<h2>MCP Lens login complete</h2><p>You can close this window.</p></body></html>',
      );
      resolveCode(code);
    } else {
      res.end(
        '<!doctype html><html lang="ko"><body style="font-family:sans-serif;text-align:center;padding:3rem">' +
          `<h2>Login failed</h2><p>${error ?? 'no authorization code'}</p></body></html>`,
      );
      rejectCode(new Error(`oauth callback error: ${error ?? 'missing authorization code'}`));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  const waitForCode = (timeoutMs: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('oauth callback timeout')), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      codePromise.then(
        (code) => {
          clearTimeout(timer);
          resolve(code);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });

  return { server, port, waitForCode };
}

/**
 * The full interactive login flow. openUrl is injected by the host (CLI: shell open, extension: vscode.env.openExternal).
 * Internally: start the ephemeral 127.0.0.1 callback server, run the SDK auth() (dynamic
 * registration + PKCE), open the browser from redirectToAuthorization, receive the authorization
 * code, exchange it with auth(code), then saveTokens. Timeout defaults to 120 seconds.
 *
 * The whole interactive path (real browser, external server round trip) cannot be unit tested; it is verified in the Wave 8C smoke run.
 */
export async function authenticateServer(
  spec: McpServerSpec,
  opts: {
    openUrl: (url: string) => void | Promise<void>;
    timeoutMs?: number;
    baseDir?: string;
    /** Pre-registered client for a server that refuses DCR. Omitted, registration is attempted as before. */
    client?: PreregisteredClient;
  },
): Promise<void> {
  if (specTransport(spec) !== 'http') {
    throw new Error(`authenticateServer: http servers only, got ${spec.name}`);
  }
  const baseDir = opts.baseDir ?? oauthDir();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const serverUrl = spec.url!;

  const cb = await startCallbackServer();
  const redirectUrl = `http://127.0.0.1:${cb.port}/callback`;
  try {
    const provider = new LensOAuthProvider(
      spec.name,
      serverUrl,
      redirectUrl,
      async (url) => {
        await opts.openUrl(url.toString());
      },
      baseDir,
      opts.client,
    );

    // Pass 1: discovery + dynamic registration + PKCE start, which opens the browser and returns 'REDIRECT'
    let first: Awaited<ReturnType<typeof auth>>;
    try {
      first = await auth(provider, { serverUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only when Lens had no client of its own: with one supplied, a 4xx means something else
      // (a wrong client id, a revoked app) and the original message is the more useful one.
      if (!opts.client && isRegistrationFailure(message)) {
        throw new ClientRegistrationRequiredError(spec.name, message);
      }
      throw err;
    }
    if (first === 'AUTHORIZED') return; // already holds a valid token (rare)

    // Wait for the authorization code
    const code = await cb.waitForCode(timeoutMs);

    // Pass 2: exchange the code for tokens and saveTokens
    const final = await auth(provider, { serverUrl, authorizationCode: code });
    if (final !== 'AUTHORIZED') {
      throw new Error(`authenticateServer: token exchange failed for ${spec.name}`);
    }
  } finally {
    cb.server.close();
  }
}
