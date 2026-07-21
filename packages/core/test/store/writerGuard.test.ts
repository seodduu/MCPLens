import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LensStore, StaleWriterError } from '../../src/store/store.js';

const DEF = (tool: string) => ({ serverName: 's', toolName: tool, definitionTokens: 1,
  scannedAt: '2026-07-22T00:00:00Z', firstScannedAt: '2026-07-22T00:00:00Z' });

let dir: string; let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guard-')); file = join(dir, 'lens.db'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeGuard', () => {
  it('가드가 false면 save가 StaleWriterError를 던진다', async () => {
    const s = await LensStore.open(file);
    s.setWriteGuard(() => false);
    expect(() => s.upsertDefinitions([DEF('a')])).toThrow(StaleWriterError);
  });

  it('가드가 true면 정상 저장', async () => {
    const s = await LensStore.open(file);
    s.setWriteGuard(() => true);
    expect(() => s.upsertDefinitions([DEF('a')])).not.toThrow();
  });

  it('reload는 외부에서 바뀐 파일 내용을 반영한다', async () => {
    const writer = await LensStore.open(file);
    writer.upsertDefinitions([DEF('a')]);           // 파일에 a 기록
    const reader = await LensStore.open(file);       // a를 읽은 상태
    writer.upsertDefinitions([DEF('a'), DEF('b')]);  // 외부(writer)가 b 추가
    reader.reload();                                 // 디스크에서 다시 읽기
    // reader가 b를 보게 됨 (definitions 조회 API로 확인)
    const names = reader.allDefinitions().map((d) => d.toolName).sort();
    expect(names).toEqual(['a', 'b']);
  });
});
