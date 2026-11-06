import { useState } from 'react';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { beatsBody, createStructureRequest, explainStructureFailure, isStaleWrite, structureUrl, updateStructureBody } from './requests.js';

const isOk = (status) => status === 200 || status === 201;

/**
 * The writes of story structures and their beat sheets in the Plan tab's Structure view. Each write goes with the sha256 last read, offers Undo in the toast
 * (`structure.showToast`), and on a 409 says the structure changed elsewhere and reloads (`refresh`).
 * @param {{ bookId: string, structure: { showToast: Function, apply: Function }, refresh: () => void }} p
 * @returns {{ state: { slug: string | null, busy: boolean, message: string | null, error: string | null }, handlersFor: (item: any, extra?: { onArchived?: () => void }) => any,
 *   create: (v: { template: string, name: string }) => Promise<{ ok: true, slug: string | null } | { ok: false, message: string }> }}
 */
export function useStructureWrites({ bookId, structure, refresh }) {
  const { track } = useWrites();
  const [state, setState] = useState({ slug: null, busy: false, message: null, error: null });

  async function write(item, url, body, done) {
    setState({ slug: item.slug, busy: true, message: null, error: null });
    const { status, json } = await track(bookId, () => send(url, body));
    if (isOk(status)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      setState({ slug: item.slug, busy: false, message: null, error: null });
      refresh();
      return true;
    }
    const message = isStaleWrite(status, json) ? 'This structure changed elsewhere; reloaded.' : null;
    setState({ slug: item.slug, busy: false, message, error: message ? null : (explainStructureFailure(status, json) ?? explainFailure(status, json)) });
    refresh();
    return false;
  }

  /** @param {any} item @param {{ onArchived?: () => void }} [extra] */
  const handlersFor = (item, { onArchived } = {}) => ({
    onSaveName: (name) => write(item, structureUrl(bookId, item.slug), updateStructureBody(item, { name }), 'Structure saved.'),
    onSaveNotes: (text) => write(item, structureUrl(bookId, item.slug), updateStructureBody(item, { body: text }), 'Structure notes saved.'),
    onSaveBeats: (list) => write(item, structureUrl(bookId, item.slug, '/beats'), beatsBody(item, list), 'Beats saved.'),
    onArchive: async () => {
      const r = await structure.apply({ url: structureUrl(bookId, item.slug, '/archive'), body: { base_sha256: item.sha256 }, done: 'Structure archived.', undoable: true, after: () => onArchived?.() });
      if (!r.ok) {
        structure.showToast({ message: `Not changed: ${r.message}` });
        refresh();
      }
    },
  });

  async function create({ template, name }) {
    const req = createStructureRequest(bookId, { template, name });
    const { status, json } = await track(bookId, () => send(req.url, req.body));
    if (isOk(status)) {
      structure.showToast({ message: 'Structure started.', opId: json?.opId ?? null });
      refresh();
      return { ok: true, slug: json?.slug ?? null };
    }
    return { ok: false, message: explainStructureFailure(status, json) ?? explainFailure(status, json) };
  }

  return { state, handlersFor, create };
}
