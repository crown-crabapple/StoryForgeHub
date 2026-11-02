// Test double for receipts-render.test.mjs (not a test file). A vite plugin points `react`, as imported by apps/web/src/export/ExportDialog.jsx, at this module so a
// server-rendered dialog (renderToStaticMarkup runs no events) can be shown in a chosen state: a useState whose initial value is 'manuscript' (the default of the
// "What to include" choice) starts as globalThis.__sfInclude instead, when that is set. Everything else is React unchanged.
import * as React from 'react';

export * from 'react';
export default React;

export function useState(initial) {
  const start = initial === 'manuscript' && globalThis.__sfInclude ? globalThis.__sfInclude : initial;
  return React.useState(start);
}
