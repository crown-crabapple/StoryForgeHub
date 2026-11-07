import { useState } from 'react';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { archiveClueRequest, createClueRequest, explainClueFailure, isClueConflict, knowersBody, restoreClueRequest, clueUrl, updateClueBody } from './clues.js';

const isOk = (status) => status === 200 || status === 201;

/** A sentence for a refused clue write. */
const explain = (status, json) => explainClueFailure(status, json) ?? explainFailure(status, json);

/**
 * The writes of the Clues view. Each save goes with the sha256 last read and offers Undo in the toast (`structure.showToast`). On a conflict nothing is reloaded by itself, so the author's
 * edits stay on screen: `state.conflict` is true and `reload()` fetches the latest.
 * @param {{ bookId: string, structure: { showToast: Function, apply: Function }, refresh: () => void }} p
 * @returns {{ state: { slug: string | null, busy: boolean, message: string | null, error: string | null, conflict: boolean },
 *   save: (item: any, patch: Parameters<typeof updateClueBody>[1], done?: string) => Promise<boolean>,
 *   saveKnowers: (item: any, rows: any[]) => Promise<boolean>, reload: () => void,
 *   create: (v: { fact: string, kind?: string }) => Promise<{ ok: true, slug: string | null } | { ok: false, message: string }>,
 *   archive: (item: any, extra?: { onArchived?: () => void }) => Promise<void>, restore: (item: any, extra?: { onRestored?: (slug: string) => void }) => Promise<void> }}
 */
export function useClueWrites({ bookId, structure, refresh }) {
  const { track } = useWrites();
  const [state, setState] = useState({ slug: null, busy: false, message: null, error: null, conflict: false });

  async function write(item, url, body, done) {
    setState({ slug: item.slug, busy: true, message: null, error: null, conflict: false });
    const { status, json } = await track(bookId, () => send(url, body));
    if (isOk(status)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      setState({ slug: item.slug, busy: false, message: null, error: null, conflict: false });
      refresh();
      return true;
    }
    setState({ slug: item.slug, busy: false, message: null, error: explain(status, json), conflict: isClueConflict(status, json) });
    return false;
  }

  const save = (item, patch, done = 'Clue saved.') => write(item, clueUrl(bookId, item.slug), updateClueBody(item, patch), done);
  const saveKnowers = (item, rows) => write(item, clueUrl(bookId, item.slug, '/knowers'), knowersBody(item, rows), 'Knowers saved.');

  function reload() {
    setState({ slug: null, busy: false, message: null, error: null, conflict: false });
    refresh();
  }

  async function create({ fact, kind }) {
    const req = createClueRequest(bookId, { fact, kind });
    const { status, json } = await track(bookId, () => send(req.url, req.body));
    if (isOk(status)) {
      structure.showToast({ message: 'Clue started.', opId: json?.opId ?? null });
      refresh();
      return { ok: true, slug: json?.slug ?? null };
    }
    return { ok: false, message: explain(status, json) };
  }

  async function archive(item, { onArchived } = {}) {
    const req = archiveClueRequest(bookId, item.slug, item);
    const r = await structure.apply({ url: req.url, body: req.body, done: 'Clue archived.', undoable: true, after: () => onArchived?.() });
    if (!r.ok) {
      structure.showToast({ message: `Not changed: ${r.message}` });
      refresh();
    }
  }

  async function restore(item, { onRestored } = {}) {
    const req = restoreClueRequest(bookId, item.slug);
    const r = await structure.apply({ url: req.url, body: req.body, done: 'Clue restored.', undoable: true, after: (json) => onRestored?.(json?.slug ?? item.slug) });
    if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
  }

  return { state, save, saveKnowers, reload, create, archive, restore };
}
