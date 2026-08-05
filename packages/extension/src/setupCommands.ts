import * as vscode from 'vscode';
import {
  authenticateServer, collectAllSpecs, readOAuthClients, saveOAuthClient,
  type LensStore, type PreregisteredClient,
} from '@mcp-lens/core';
import { scanNow, type AfterScan } from './autoScan.js';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_PROMPT_TITLE,
  AUTOMATION_SCAN_ONLY_LABEL, ensureAutomationConsent,
} from './automationConsent.js';

/** The command the "Scan servers" button of the onboarding walkthrough points at. */
export function registerScanNow(store: () => LensStore, refresh: () => void, afterScan?: AfterScan): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.scanNow', async () => {
    try {
      await scanNow(store(), refresh, afterScan);
    } catch (err) {
      // store.save() throws StaleWriterError unless this window holds the writer lease.
      // This is the walkthrough's primary button, so the raw extension host error becomes guidance.
      if (err instanceof Error && err.name === 'StaleWriterError') {
        void vscode.window.showInformationMessage(
          'MCP Lens: another VS Code window is currently writing to the Lens database. Try again in a moment.');
        return;
      }
      throw err;
    }
  });
}

/**
 * The command the "Open Global Actions setting" button of the onboarding walkthrough points at.
 *
 * Before opening the setting, consent for handling new servers automatically is collected once. It
 * is the last onboarding step, after the user has chosen a provider and finished an analysis, so
 * they have already experienced what they are consenting to. The answer is written to settings and never asked again.
 */
export function registerOpenRolloutSetting(): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.openRolloutSetting', async () => {
    await askAutomationConsentOnce();
    await vscode.commands.executeCommand(
      'workbench.action.openSettings', 'mcplens.dependencyAnalysis.rollout');
  });
}

/**
 * Never asks again once answered. Delegates to ensureAutomationConsent, shared with the consent
 * check that analyzeAfterScan in extension.ts runs, so both callers make the same promise with the
 * same wording.
 */
async function askAutomationConsentOnce(): Promise<void> {
  const config = vscode.workspace.getConfiguration('mcpLens');
  await ensureAutomationConsent(
    config,
    () => vscode.window.showInformationMessage(
      AUTOMATION_PROMPT_TITLE,
      { modal: true, detail: AUTOMATION_PROMPT_DETAIL },
      AUTOMATION_ACCEPT_LABEL, AUTOMATION_SCAN_ONLY_LABEL),
    vscode.ConfigurationTarget.Global);
}

/**
 * A row click passes `{ serverName }` (the setupTreeProvider convention), while the inline hover
 * button of a view/item/context menu passes the tree element itself, `{ kind: 'row', row }`.
 * Both reach the same command, so the server name is read from either shape.
 */
function serverNameOf(node?: AuthenticateArg): string | undefined {
  return node?.serverName ?? node?.row?.label;
}

/** No-op when the server was not ignored, so the plain "sign in to scan" path costs nothing. */
async function dropFromAuthIgnore(serverName: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('mcpLens');
  const ignore = config.get<string[]>('authIgnore', []);
  if (!ignore.includes(serverName)) return;
  await config.update(
    'authIgnore', ignore.filter((name) => name !== serverName), vscode.ConfigurationTarget.Global);
}

type AuthenticateArg = { serverName?: string; row?: { label?: string } };

/**
 * The client id for a server that refuses dynamic registration.
 *
 * The `mcpLens.oauthClients` setting wins, since a value typed into settings.json is an explicit
 * override. Otherwise the shared ~/.mcplens/oauth/clients.json is used, which the CLI reads too, so
 * a client registered from either side works from both. Secrets live only in that file (mode 0600)
 * and never in settings.json, which syncs across machines.
 */
function preregisteredClient(serverName: string): PreregisteredClient | undefined {
  const configured = vscode.workspace.getConfiguration('mcpLens')
    .get<Record<string, string>>('oauthClients', {})[serverName];
  const stored = readOAuthClients()[serverName];
  if (configured) return { clientId: configured, clientSecret: stored?.clientSecret };
  return stored;
}

function reportSignInFailure(serverName: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`MCP Lens: sign-in failed for ${serverName}: ${msg}`);
}

/**
 * Asks for the client id (and optional secret) of a server that refused to register Lens itself.
 * undefined when the user dismisses either box: a login nobody wants to finish must not be retried.
 */
async function askForClient(serverName: string): Promise<PreregisteredClient | undefined> {
  const clientId = await vscode.window.showInputBox({
    title: `MCP Lens: OAuth client id for ${serverName}`,
    prompt: `${serverName} does not register clients automatically. Create an OAuth app with this provider and paste its client id.`,
    ignoreFocusOut: true,
    placeHolder: 'client id',
  });
  if (!clientId) return undefined;
  const clientSecret = await vscode.window.showInputBox({
    title: `MCP Lens: OAuth client secret for ${serverName}`,
    prompt: 'Leave empty for a public (PKCE-only) app.',
    ignoreFocusOut: true,
    password: true,
  });
  if (clientSecret === undefined) return undefined;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/**
 * Command used by the "sign in to scan" row of the Setup Status view and by the hover button of an
 * ignored row. Hidden from the palette (when: false) because there is no way to run it without a
 * server name argument. It follows exactly the call style of maybeAuthPrompt in autoScan.ts
 * (openUrl -> vscode.env.openExternal).
 */
export function registerAuthenticateServer(refresh: () => void): vscode.Disposable {
  const run = async (node?: AuthenticateArg): Promise<void> => {
    const serverName = serverNameOf(node);
    if (!serverName) return;
    const { specs } = collectAllSpecs();
    const spec = specs.find((s) => s.name === serverName);
    if (!spec) return;
    const signIn = async (client?: PreregisteredClient): Promise<void> => {
      await authenticateServer(spec, {
        openUrl: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
        client,
      });
      // Signing in is the opposite of ignoring, so the suppression is lifted here. Left in place,
      // the row would stay "ignored" right after a successful sign-in and never be scanned.
      await dropFromAuthIgnore(serverName);
      void vscode.window.showInformationMessage(`MCP Lens: signed in to ${serverName}. Run a scan to pick it up.`);
    };
    try {
      await signIn(preregisteredClient(serverName));
    } catch (err) {
      // Registration refused is not a dead end, it is a missing client id, so it is asked for and
      // the login is retried once. Any other failure is reported as is.
      if (err instanceof Error && err.name === 'ClientRegistrationRequiredError') {
        const client = await askForClient(serverName);
        if (client) {
          saveOAuthClient(serverName, client);
          try {
            await signIn(client);
          } catch (retryErr) {
            reportSignInFailure(serverName, retryErr);
          }
        }
      } else {
        reportSignInFailure(serverName, err);
      }
    }
    refresh();
  };
  // Two ids, one behaviour. An inline tree button with an icon renders as a small glyph that is easy
  // to miss, so the ignored row gets its own id whose short title ("Sign in") is drawn as text.
  return vscode.Disposable.from(
    vscode.commands.registerCommand('mcp-lens.authenticateServer', run),
    vscode.commands.registerCommand('mcp-lens.signInIgnoredServer', run));
}
