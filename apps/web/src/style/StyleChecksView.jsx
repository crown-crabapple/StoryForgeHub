import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteJson, useApi } from '../api.js';
import { bookUrl, send } from '../structure/helpers.js';
import { StyleChecksPage } from './StyleChecksPage.jsx';
import { chaptersOf, parseGroup, scopeBody } from './model.js';

const POLL_MS = 500;

/** A sentence for a refused request. @param {{ status: number, json: any }} r @param {string} fallback */
const refusal = (r, fallback) => (r.status === 0 ? 'The server could not be reached.' : (r.json?.message ?? `${fallback} (${r.status}).`));

/**
 * /books/:id/style (M13-J03 section 9). Reads the book's effective style settings and structure, starts a scan (POST /checks/style/scans), polls it every 500 ms while it runs, and
 * applies, dismisses and restores through the server. `search` is the query string; `?group=rule|chapter` is kept in the address (the toggle is a link).
 * @param {{ bookId: string, search?: string }} props
 */
export function StyleChecksView({ bookId, search = '' }) {
  const prefs = useApi(`/api/preferences?book=${encodeURIComponent(bookId)}`);
  const book = useApi(bookUrl(bookId));
  const [scope, setScope] = useState(/** @type {import('./model.js').ScopeChoice} */ ({ kind: 'manuscript', chapterKey: null, ids: [] }));
  const [scanId, setScanId] = useState(/** @type {string | null} */ (null));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(/** @type {string | null} */ (null));
  const [tick, setTick] = useState(0);
  const [polled, setPolled] = useState(/** @type {{ status: any, findings: any[], error: string | null, gone: boolean, loading: boolean }} */ ({ status: null, findings: [], error: null, gone: false, loading: false }));
  const held = useRef(/** @type {any[]} */ ([]));
  const [cards, setCards] = useState(/** @type {Record<string, any>} */ ({}));
  const [changed, setChanged] = useState(/** @type {Record<string, number>} */ ({}));
  const [rev, setRev] = useState(0);
  const [notice, setNotice] = useState(/** @type {string | null} */ (null));

  const enabled = prefs.data?.effective?.checks?.style?.enabled === true;
  const chapters = useMemo(() => chaptersOf(book.data), [book.data]);
  const scan = useMemo(() => (polled.status ? { ...polled.status, findings: polled.findings } : null), [polled]);
  const dismissals = useApi(enabled ? bookUrl(bookId, '/checks/style/dismissals') : null, String(rev));

  // poll every 500 ms until the scan is not running; each poll asks only for the findings after the ones already held (?from=) and appends them
  useEffect(() => {
    if (!scanId) return undefined;
    let stop = false;
    let timer = null;
    const url = bookUrl(bookId, `/checks/style/scans/${encodeURIComponent(scanId)}`);
    const poll = async () => {
      let again = false;
      try {
        const res = await fetch(`${url}?from=${held.current.length}`, { headers: { accept: 'application/json' } });
        if (stop) return;
        if (res.status === 404) setPolled((p) => ({ ...p, gone: true, loading: false }));
        else if (!res.ok) setPolled((p) => ({ ...p, error: 'The scan could not be read from the server.', loading: false }));
        else {
          const json = await res.json();
          if (stop) return;
          const { findings = [], ...status } = json;
          if (findings.length > 0) held.current = [...held.current, ...findings];
          setPolled({ status, findings: held.current, error: null, gone: false, loading: false });
          again = status.state === 'running';
        }
      } catch {
        if (!stop) setPolled((p) => ({ ...p, error: 'The scan could not be read from the server.', loading: false }));
      }
      if (again && !stop) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [scanId, bookId, tick]);

  const setCard = (id, patch) => setCards((c) => ({ ...c, [id]: { phase: 'idle', ...c[id], ...patch } }));
  const sceneBump = (sceneId, by) =>
    setChanged((c) => {
      const n = Math.max(0, (c[sceneId] ?? 0) + by);
      const next = { ...c };
      if (n === 0) delete next[sceneId];
      else next[sceneId] = n;
      return next;
    });

  const beginScan = (id) => {
    held.current = [];
    setPolled({ status: null, findings: [], error: null, gone: false, loading: true });
    setCards({});
    setChanged({});
    setScanId(id);
    setTick((n) => n + 1);
  };

  const run = async () => {
    const body = scopeBody(scope, chapters);
    if (!body) return;
    setStarting(true);
    setStartError(null);
    setNotice(null);
    const r = await send(bookUrl(bookId, '/checks/style/scans'), { scope: body });
    setStarting(false);
    if (r.status === 202 && r.json?.scanId) {
      beginScan(r.json.scanId);
    } else if (r.status === 409 && (r.json?.error ?? r.json?.code) === 'SCAN_RUNNING') {
      setStartError('A scan of this book was already running; showing its progress.');
      if (r.json?.scanId) beginScan(r.json.scanId);
    }
    else if (r.status === 409 && (r.json?.error ?? r.json?.code) === 'STYLE_OFF') setStartError('Style checks are off for this book. Turn them on in Settings.');
    else setStartError(refusal(r, 'The scan could not start'));
  };

  const handlers = {
    onScopeKind: (kind) => setScope((s) => ({ ...s, kind })),
    onChapter: (key) => setScope((s) => ({ ...s, chapterKey: key === '' ? null : key })),
    onToggleScene: (id) => setScope((s) => ({ ...s, ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] })),
    onRun: run,
    onCancel: async () => {
      if (scanId) await send(bookUrl(bookId, `/checks/style/scans/${encodeURIComponent(scanId)}/cancel`), {});
      setTick((n) => n + 1);
    },
    onApply: async (f, index) => {
      const replacement = f.replacements[index];
      setCard(f.id, { phase: 'busy', error: null });
      const r = await send(bookUrl(bookId, `/scenes/${encodeURIComponent(f.sceneId)}/apply-finding`), {
        baseSha256: f.fileSha256,
        from: f.range.from,
        to: f.range.to,
        original: f.original,
        replacement,
        ruleId: f.ruleId,
        engine: f.engine,
      });
      if (r.status === 200 && r.json?.ok) {
        setCard(f.id, { phase: 'applied', replacement, opId: r.json.undo?.opId ?? r.json.opId, error: null });
        sceneBump(f.sceneId, 1);
      } else if ((r.json?.error ?? r.json?.code) === 'SCENE_CHANGED') setCard(f.id, { phase: 'idle', error: 'The scene changed since the scan, so nothing was changed. Run the scan again.' });
      else setCard(f.id, { phase: 'idle', error: refusal(r, 'Not applied') });
    },
    onUndo: async (f) => {
      const opId = cards[f.id]?.opId;
      if (!opId) return;
      const r = await send(bookUrl(bookId, `/ops/${encodeURIComponent(opId)}/restore`), {});
      if (r.status === 200) {
        setCard(f.id, { phase: 'idle', opId: null, error: null });
        sceneBump(f.sceneId, -1);
      } else setCard(f.id, { error: refusal(r, 'Not undone') });
    },
    onDismiss: async (f, note) => {
      setCard(f.id, { phase: 'busy', error: null });
      const r = await send(bookUrl(bookId, '/checks/style/dismissals'), {
        fingerprint: f.fingerprint,
        rule: f.ruleId,
        sceneId: f.sceneId,
        text: f.original,
        ...(note ? { note } : {}),
      });
      if (r.status === 200 || r.status === 201 || (r.status === 409 && (r.json?.error ?? r.json?.code) === 'ALREADY_DISMISSED')) {
        setCard(f.id, { phase: 'dismissed' });
        setRev((n) => n + 1);
      } else setCard(f.id, { phase: 'idle', error: refusal(r, 'Not dismissed') });
    },
    onRestore: async (slug) => {
      const r = await deleteJson(bookUrl(bookId, `/checks/style/dismissals/${encodeURIComponent(slug)}`)).catch(() => ({ status: 0, json: null }));
      if (r.status === 200) {
        setNotice('Restored. The suggestion comes back the next time you run a scan.');
        setRev((n) => n + 1);
      } else setNotice(refusal(r, 'Not restored'));
    },
    onRemove: async (slug) => {
      const r = await deleteJson(bookUrl(bookId, `/checks/style/dismissals/${encodeURIComponent(slug)}`)).catch(() => ({ status: 0, json: null }));
      if (r.status === 200) {
        setNotice('Removed.');
        setRev((n) => n + 1);
      } else setNotice(refusal(r, 'Not removed'));
    },
  };

  if (prefs.error || book.error) {
    return (
      <main id="main" tabIndex={-1} className="page error">
        {prefs.error ?? book.error}
      </main>
    );
  }
  if (!prefs.loading && prefs.data === null) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Book not found</h1>
      </main>
    );
  }
  return (
    <StyleChecksPage
      bookId={bookId}
      loading={prefs.loading}
      enabled={enabled}
      chapters={chapters}
      scope={scope}
      canRun={scopeBody(scope, chapters) !== null}
      starting={starting}
      startError={startError ?? polled.error}
      scan={scan}
      scanGone={scanId !== null && polled.gone}
      group={parseGroup(search)}
      cards={cards}
      changedScenes={Object.keys(changed)}
      dismissals={Array.isArray(dismissals.data?.dismissals) ? dismissals.data.dismissals : null}
      notice={notice}
      handlers={handlers}
    />
  );
}
