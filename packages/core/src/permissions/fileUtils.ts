// packages/core/src/permissions/fileUtils.ts — vscode import 금지
// permissions 모듈 공용 JSON 파일 IO. 원본 보호: 쓰기 전 .mcplens.bak 백업 + tmp/rename.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** JSON 파일 읽기. 파일 없으면 null. 파싱 실패는 throw — 관대/엄격은 호출부가 결정한다. */
export function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** 원본 보호 쓰기: 기존 파일을 .mcplens.bak으로 백업 후 tmp에 쓰고 rename. */
export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.mcplens.bak`);
  const tmp = `${filePath}.mcplens.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}
