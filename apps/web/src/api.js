// The only way the UI talks to the server: GET /api/*, plus the guarded write calls.
import { useEffect, useState } from 'react';

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/**
 * Fetch JSON for a URL (null url = nothing to load). Changing `refreshKey` fetches again but keeps showing
 * the previous data meanwhile (no "Loading..." flash); changing the url starts from scratch.
 * @returns {{ data: any, error: string | null, loading: boolean }} data is null on 404.
 */
export function useApi(url, refreshKey = '') {
  const [state, setState] = useState({ url: null, data: null, error: null });
  useEffect(() => {
    if (!url) return undefined;
    const ctrl = new AbortController();
    getJson(url, ctrl.signal).then(
      (data) => setState({ url, data, error: null }),
      (e) => {
        if (e.name !== 'AbortError') setState({ url, data: null, error: e.message });
      },
    );
    return () => ctrl.abort();
  }, [url, refreshKey]);
  const ready = url !== null && state.url === url;
  return {
    data: ready ? state.data : null,
    error: ready ? state.error : null,
    loading: url !== null && !ready,
  };
}

/**
 * POST JSON to a write route. The x-storyforge header is required by the server's write guard.
 * @returns {Promise<{ status: number, json: any }>}
 */
export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json };
}
