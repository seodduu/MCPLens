// packages/cli/src/auth-open.ts
import { spawn } from 'node:child_process';

/** Command and args used to open a URL (pure function, split out so platform branches are testable). */
export interface OpenCommand {
  command: string;
  args: string[];
}

/**
 * Picks the browser-open command per platform.
 * macOS uses `open`, Windows uses `cmd /c start` (a builtin, so it must go through cmd),
 * everything else falls back to `xdg-open`.
 */
export function resolveOpenCommand(platform: NodeJS.Platform, url: string): OpenCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  return { command: 'xdg-open', args: [url] };
}

/** Opens a URL in the browser for the current platform. Injected as authenticateServer's openUrl callback. */
export function openUrl(url: string): void {
  const { command, args } = resolveOpenCommand(process.platform, url);
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}
