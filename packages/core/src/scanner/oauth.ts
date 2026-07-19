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
 * Lens가 한 http MCP 서버에 대해 정식 발급받은 OAuth 자격증명의 디스크 표현.
 * 클라이언트(Claude Code 등)가 저장한 토큰은 절대 재사용하지 않는다 — Lens 명의로 발급.
 */
export interface StoredOAuth {
  serverName: string;
  serverUrl: string;
  /** SDK 동적 클라이언트 등록 결과 (OAuthClientInformationMixed 직렬화) */
  clientInformation?: unknown;
  /** access/refresh 토큰 (OAuthTokens 직렬화) */
  tokens?: unknown;
  updatedAt: string;
}

/** 서버명을 파일명으로 안전하게 변환 (경로 이탈 방지). */
function safeFileName(serverName: string): string {
  const base = serverName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${base || '_'}.json`;
}

/** ~/.mcplens/oauth/<serverName>.json 을 읽는다. 없거나 파싱 실패면 null. */
export function loadStoredOAuth(serverName: string, baseDir: string = oauthDir()): StoredOAuth | null {
  const file = path.join(baseDir, safeFileName(serverName));
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredOAuth;
  } catch {
    return null;
  }
}

/** 자격증명을 0600 모드로 저장한다 (평문 — 아래 보안 주석 참조). */
export function saveStoredOAuth(data: StoredOAuth, baseDir: string = oauthDir()): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const file = path.join(baseDir, safeFileName(data.serverName));
  // writeFileSync의 mode는 신규 생성 시에만 적용되므로 chmod로 기존 파일까지 강제한다.
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 저장된 자격증명을 삭제한다 (없으면 무시). */
export function clearStoredOAuth(serverName: string, baseDir: string = oauthDir()): void {
  const file = path.join(baseDir, safeFileName(serverName));
  rmSync(file, { force: true });
}

/**
 * SDK OAuthClientProvider 구현체.
 * 토큰·클라이언트 등록 정보는 StoredOAuth 파일에 영속하고, PKCE code verifier는
 * 인메모리로만 (같은 로그인 플로우 내 두 auth() 호출 사이 유지, 디스크 미저장).
 * redirect 처리(브라우저 열기)는 host가 주입하는 onRedirect 콜백에 위임한다.
 */
class LensOAuthProvider implements OAuthClientProvider {
  private _codeVerifier?: string;

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly _redirectUrl: string,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
    private readonly baseDir: string,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    // client_name = "MCP Lens" → 서버 동의 화면에 Lens 명의가 표시된다 (자격증명 원칙).
    return {
      client_name: 'MCP Lens',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
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
    if (!this._codeVerifier) throw new Error('code verifier가 설정되지 않았습니다 (인증 플로우 순서 오류)');
    return this._codeVerifier;
  }
}

/**
 * 저장 토큰이 있는 http spec에 쓸 비인터랙티브 Provider.
 * 저장 데이터/토큰이 없거나 http가 아니면 null. redirectToAuthorization은 즉시 throw —
 * 스캔 중 브라우저가 열리는 일은 없다 (스캔 비인터랙티브 불변).
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
    'http://127.0.0.1/callback', // 플레이스홀더 — 스캔 중엔 redirect가 일어나지 않는다
    () => {
      throw new Error(
        `auth-required: ${spec.name} — 로그인이 필요합니다 (mcp-lens auth ${spec.name})`,
      );
    },
    baseDir,
  );
}

/** 127.0.0.1 임시 포트 콜백 서버. authorization code 수신부를 분리 테스트 가능하게 노출한다. */
export interface CallbackServer {
  server: http.Server;
  port: number;
  /** timeoutMs 안에 /callback?code=... 을 수신하면 code로 resolve, 아니면 reject. */
  waitForCode(timeoutMs: number): Promise<string>;
}

export async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // waitForCode가 호출되기 전에 콜백이 도착/실패할 수 있으므로, 지연-거부가
  // unhandled rejection으로 새지 않게 무해한 핸들러를 즉시 붙인다.
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
          '<h2>MCP Lens 로그인 완료</h2><p>이 창을 닫아도 됩니다.</p></body></html>',
      );
      resolveCode(code);
    } else {
      res.end(
        '<!doctype html><html lang="ko"><body style="font-family:sans-serif;text-align:center;padding:3rem">' +
          `<h2>로그인 실패</h2><p>${error ?? 'authorization code 없음'}</p></body></html>`,
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
 * 인터랙티브 로그인 전체 플로우. openUrl은 host가 주입 (CLI: 셸 open / 확장: vscode.env.openExternal).
 * 내부: 127.0.0.1 임시 포트 콜백 서버 기동 → SDK auth() (동적 등록 + PKCE) →
 * redirectToAuthorization에서 브라우저 열기 → authorization code 수신 →
 * auth(code)로 토큰 교환 → saveTokens. 타임아웃 기본 120초.
 *
 * 전체 인터랙티브 경로(실 브라우저·외부 서버 왕복)는 유닛 불가 — Wave 8C 스모크에서 검증.
 */
export async function authenticateServer(
  spec: McpServerSpec,
  opts: { openUrl: (url: string) => void | Promise<void>; timeoutMs?: number; baseDir?: string },
): Promise<void> {
  if (specTransport(spec) !== 'http') {
    throw new Error(`authenticateServer: http 서버만 지원 — ${spec.name}`);
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
    );

    // 1차: 디스커버리 + 동적 등록 + PKCE 시작 → 브라우저 열림, 'REDIRECT' 반환
    const first = await auth(provider, { serverUrl });
    if (first === 'AUTHORIZED') return; // 이미 유효 토큰 보유 (드묾)

    // authorization code 수신 대기
    const code = await cb.waitForCode(timeoutMs);

    // 2차: code → 토큰 교환 + saveTokens
    const final = await auth(provider, { serverUrl, authorizationCode: code });
    if (final !== 'AUTHORIZED') {
      throw new Error(`authenticateServer: 토큰 교환 실패 — ${spec.name}`);
    }
  } finally {
    cb.server.close();
  }
}
