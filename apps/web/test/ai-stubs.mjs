// Test doubles for the render tests in ai-render.test.mjs (not a test file). A vite plugin points `../api.js` and `./useExchange.js`, as imported from apps/web/src/ai/,
// at these, so a component can be rendered (renderToStaticMarkup runs no effects) in a chosen data / exchange state:
//   globalThis.__sfApi       { [url]: data }          what useApi(url) returns (404 -> null)
//   globalThis.__sfExchange  { pkg, result, busy, error, pendingCloud }   what useExchange(bookId) returns
const noop = () => {};

export function useApi(url) {
  const table = globalThis.__sfApi ?? {};
  const data = url && Object.hasOwn(table, url) ? table[url] : null;
  return { data, error: null, loading: false };
}
export async function postJson() {
  throw new Error('render tests never write');
}
export async function putJson() {
  throw new Error('render tests never write');
}

export function useExchange() {
  return { pkg: null, result: null, busy: false, error: null, setError: noop, pendingCloud: false, streaming: false, streamText: '', cancel: noop, preview: noop, send: noop, confirmCloud: noop, cancelCloud: noop, reset: noop, ...(globalThis.__sfExchange ?? {}) };
}
