// packages/cli/src/auth-open.ts
import { spawn } from 'node:child_process';

/** URL 열기에 쓸 커맨드/인자 (순수 함수 — 플랫폼별 분기를 유닛테스트 가능하게 분리). */
export interface OpenCommand {
  command: string;
  args: string[];
}

/**
 * 플랫폼별 브라우저 오픈 커맨드 선택.
 * macOS는 `open`, Windows는 `cmd /c start`(내장 커맨드라 cmd 경유 필수), 그 외는 `xdg-open`으로 폴백.
 */
export function resolveOpenCommand(platform: NodeJS.Platform, url: string): OpenCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  return { command: 'xdg-open', args: [url] };
}

/** 현재 플랫폼 기준으로 브라우저에서 URL을 연다. authenticateServer의 openUrl 콜백으로 주입한다. */
export function openUrl(url: string): void {
  const { command, args } = resolveOpenCommand(process.platform, url);
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}
