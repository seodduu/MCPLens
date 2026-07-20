// packages/core/src/report/index.ts
// 조치 중심 리포트의 공개 표면. 실물은 Wave 1에서 채워진다.
import type { EngineInput } from '../engine/engine.js';
import type { ReportModel, ReportOptions } from './model.js';

export * from './model.js';

/**
 * EngineInput → ReportModel (집계·버킷팅·서버 롤업).
 * 구현: Task 35 — `./rollup.js`로 교체된다.
 */
export function buildReport(_input: EngineInput, _opts: ReportOptions): ReportModel {
  throw new Error('buildReport: not implemented (Task 35)');
}

/**
 * ReportModel → 마크다운 문자열.
 * 구현: Task 36 — `./markdown.js`로 교체된다.
 */
export function renderReport(_model: ReportModel, _opts: ReportOptions): string {
  throw new Error('renderReport: not implemented (Task 36)');
}
