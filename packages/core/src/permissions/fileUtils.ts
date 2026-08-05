// packages/core/src/permissions/fileUtils.ts (never import vscode)
// Shared JSON file IO for the permissions modules. Original protection: back up to .mcplens.bak
// before writing, then write to tmp and rename.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Reads a JSON file. null when the file is missing. A parse failure throws; the caller decides lenient vs strict. */
export function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Original-protecting write: back the existing file up to .mcplens.bak, write to tmp, then rename. */
export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.mcplens.bak`);
  const tmp = `${filePath}.mcplens.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}
