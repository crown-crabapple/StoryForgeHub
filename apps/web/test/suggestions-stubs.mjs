// Test double for suggestions-render.test.mjs (not a test file). A vite plugin points `../api.js`, as imported from apps/web/src/suggestions/, at this module, so
// RailSuggestions (which loads its own list with useApi) can be rendered by renderToStaticMarkup (no effects run) in a chosen data state:
//   globalThis.__sfApi   { [url]: data }   what useApi(url) returns (unknown url -> null, i.e. still loading)
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
