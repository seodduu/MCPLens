// packages/core/src/report/index.ts
// 조치 중심 리포트의 공개 표면.
// buildReport(집계) → renderReport(마크다운)의 2단 파이프라인이다.

export * from './model.js';
export { buildReport } from './rollup.js';
export { renderReport } from './markdown.js';
