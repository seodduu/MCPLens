// packages/core/src/report/index.ts
// Public surface of the action-first report.
// A two-stage pipeline: buildReport (aggregate) then renderReport (markdown).

export * from './model.js';
export { buildReport } from './rollup.js';
export { renderReport } from './markdown.js';
