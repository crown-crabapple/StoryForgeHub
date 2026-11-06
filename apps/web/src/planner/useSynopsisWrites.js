import { useState } from 'react';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { archiveSynopsisRequest, createSynopsisRequest, extractUrl, isSynopsisConflict, restoreSynopsisRequest, synopsisUrl, updateSynopsisBody } from './synopsis.js';

const isOk = (status) => status === 200 || status === 201;

/** GET the offline extract of a synopsis. Never throws. @returns {Promise<{ ok: true, text: string, basis: string, skipped: number } | { ok: false, message: string }>} */
async function fetchExtract(bookId, slug) {
  try {
    const res = await fetch(extractUrl(bookId, slug), { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, message: res.status === 404 ? 'That synopsis is not there any more. Reload the page.' : `The plan could not be read (${res.status}).` };
    const json = await res.json();
    return { ok: true, text: String(json?.text ?? ''), basis: String(json?.basis ?? ''), skipped: Number(json?.skipped ?? 0) };
  } catch {
    return { ok: false, message: 'The server could not be reached.' };
  }
}

/** A sentence for a refused synopsis write. */
const explain = (status, json) => (isSynopsisConflict(status, json) ? 'This synopsis changed elsewhere. Reload to see the latest text; your edits here are kept until you do.' : explainFailure(status, json));

/**
 * The writes of the Synopsis view. Each save goes with the sha256 last read and offers Undo in the toast (`structure.showToast`). On a conflict nothing is reloaded by itself, so the
 * author's edits stay on screen: `state.conflict` is true and `reload()` fetches the latest.
 * @param {{ bookId: string, structure: { showToast: Function, apply: Function }, refresh: () => void }} p
 * @returns {{ state: { slug: string | null, busy: boolean, message: string | null, error: string | null, conflict: boolean },
 *   save: (item: any, patch: { name?: string, target_words?: number | null, body?: string, basis?: string | null }, done?: string) => Promise<boolean>,
 *   extract: (slug: string) => ReturnType<typeof fetchExtract>, keepMyText: (item: any) => Promise<boolean>, reload: () => void,
 *   create: (v: { type: string, name?: string, target_words?: number | null }) => Promise<{ ok: true, slug: string | null } | { ok: false, message: string }>,
 *   archive: (item: any, extra?: { onArchived?: () => void }) => Promise<void>, restore: (item: any, extra?: { onRestored?: (slug: string) => void }) => Promise<void> }}
 */
export function useSynopsisWrites({ bookId, structure, refresh }) {
  const { track } = useWrites();
  const [state, setState] = useState({ slug: null, busy: false, message: null, error: null, conflict: false });

  async function save(item, patch, done = 'Synopsis saved.') {
    setState({ slug: item.slug, busy: true, message: null, error: null, conflict: false });
    const { status, json } = await track(bookId, () => send(synopsisUrl(bookId, item.slug), updateSynopsisBody(item, patch)));
    if (isOk(status)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      setState({ slug: item.slug, busy: false, message: null, error: null, conflict: false });
      refresh();
      return true;
    }
    const conflict = isSynopsisConflict(status, json);
    setState({ slug: item.slug, busy: false, message: null, error: explain(status, json), conflict });
    return false;
  }

  /** "Keep my text": store the fresh basis, leave the body alone. */
  async function keepMyText(item) {
    const got = await fetchExtract(bookId, item.slug);
    if (!got.ok) {
      setState({ slug: item.slug, busy: false, message: null, error: got.message, conflict: false });
      return false;
    }
    return save(item, { basis: got.basis }, 'Kept your text.');
  }

  function reload() {
    setState({ slug: null, busy: false, message: null, error: null, conflict: false });
    refresh();
  }

  async function create({ type, name, target_words }) {
    const req = createSynopsisRequest(bookId, { type, name, target_words });
    const { status, json } = await track(bookId, () => send(req.url, req.body));
    if (isOk(status)) {
      structure.showToast({ message: 'Synopsis started.', opId: json?.opId ?? null });
      refresh();
      return { ok: true, slug: json?.slug ?? null };
    }
    return { ok: false, message: explainFailure(status, json) };
  }

  async function archive(item, { onArchived } = {}) {
    const req = archiveSynopsisRequest(bookId, item.slug);
    const r = await structure.apply({ url: req.url, body: req.body, done: 'Synopsis archived.', undoable: true, after: () => onArchived?.() });
    if (!r.ok) {
      structure.showToast({ message: `Not changed: ${r.message}` });
      refresh();
    }
  }

  async function restore(item, { onRestored } = {}) {
    const req = restoreSynopsisRequest(bookId, item.slug);
    const r = await structure.apply({ url: req.url, body: req.body, done: 'Synopsis restored.', undoable: true, after: (json) => onRestored?.(json?.slug ?? item.slug) });
    if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
  }

  return { state, save, extract: (slug) => fetchExtract(bookId, slug), keepMyText, reload, create, archive, restore };
}
