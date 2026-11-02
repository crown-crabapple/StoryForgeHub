// The only way the UI talks to the server: GET /api/*.
import { useEffect, useState } from 'react';

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/**
 * Fetch JSON for a URL (null url = nothing to load).
 * @returns {{ data: any, error: string | null, loading: boolean }} data is null on 404.
 */
export function useApi(url) {
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
  }, [url]);
  const ready = url !== null && state.url === url;
  return {
    data: ready ? state.data : null,
    error: ready ? state.error : null,
    loading: url !== null && !ready,
  };
}
