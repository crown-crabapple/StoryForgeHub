import { useCallback, useEffect, useState } from 'react';
import { postJson } from './api.js';

/** One state for the whole library: building beats stale/error beats fresh. */
function overall(items) {
  if (!items || items.length === 0) return null;
  if (items.some((i) => i.state === 'building')) return 'building';
  if (items.some((i) => i.state === 'error')) return 'error';
  if (items.some((i) => i.state !== 'fresh')) return 'stale';
  return 'fresh';
}

const LABEL = { fresh: 'Index up to date', building: 'Index building', stale: 'Index out of date', error: 'Index unreadable' };

export function IndexStatus() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/index/status', { headers: { accept: 'application/json' } });
      if (res.ok) setState(overall(await res.json()));
    } catch {
      // the server is not reachable; keep the last state
    }
  }, []);

  useEffect(() => {
    let stop = false;
    let timer;
    const tick = async () => {
      await load();
      if (!stop) timer = setTimeout(tick, 4000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  async function rebuild() {
    setBusy(true);
    try {
      await postJson('/api/index/rebuild', {});
    } finally {
      setBusy(false);
      load();
    }
  }

  if (state === null) return null;
  const shown = busy ? 'building' : state;
  return (
    <div className="index-status">
      <span className={`dot dot-${shown}`} role="img" aria-label={LABEL[shown]} title={LABEL[shown]} />
      <span className="muted">{shown}</span>
      <button type="button" onClick={rebuild} disabled={busy}>
        Rebuild index
      </button>
    </div>
  );
}
