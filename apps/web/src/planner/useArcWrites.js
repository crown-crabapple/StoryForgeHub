import { useState } from 'react';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { arcUrl, createArcRequest, explainArcFailure, isStaleWrite, milestonesBody, updateArcBody } from './requests.js';

const isOk = (status) => status === 200 || status === 201;

/**
 * The writes of character arcs, shared by the Codex Arc panel and the Plan tab's Arcs view. Each write goes with the sha256 last read, offers Undo in the toast
 * (`structure.showToast`), and on a 409 says the arc changed elsewhere and reloads (`refresh`).
 * @param {{ bookId: string, structure: { showToast: Function, apply: Function }, refresh: () => void }} p
 * @returns {{ state: { slug: string | null, busy: boolean, message: string | null, error: string | null }, handlersFor: (arc: any, extra?: { onArchived?: () => void }) => any,
 *   create: (v: { character: string, arc_type?: string | null }) => Promise<{ ok: true, slug: string | null } | { ok: false, message: string, existing?: string | null }> }}
 */
export function useArcWrites({ bookId, structure, refresh }) {
  const { track } = useWrites();
  const [state, setState] = useState({ slug: null, busy: false, message: null, error: null });

  async function write(arc, url, body, done) {
    setState({ slug: arc.slug, busy: true, message: null, error: null });
    const { status, json } = await track(bookId, () => send(url, body));
    if (isOk(status)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      setState({ slug: arc.slug, busy: false, message: null, error: null });
      refresh();
      return true;
    }
    const message = isStaleWrite(status, json) ? 'This arc changed elsewhere; reloaded.' : null;
    setState({ slug: arc.slug, busy: false, message, error: message ? null : (explainArcFailure(status, json) ?? explainFailure(status, json)) });
    refresh();
    return false;
  }

  /** @param {any} arc @param {{ onArchived?: () => void }} [extra] */
  const handlersFor = (arc, { onArchived } = {}) => ({
    onSaveType: (value) => write(arc, arcUrl(bookId, arc.slug), updateArcBody(arc, { arc_type: value }), 'Arc saved.'),
    onSaveField: (key, value) => write(arc, arcUrl(bookId, arc.slug), updateArcBody(arc, { fields: { [key]: value } }), 'Arc saved.'),
    onSaveNotes: (text) => write(arc, arcUrl(bookId, arc.slug), updateArcBody(arc, { body: text }), 'Arc notes saved.'),
    onSaveMilestones: (list) => write(arc, arcUrl(bookId, arc.slug, '/milestones'), milestonesBody(arc, list), 'Milestones saved.'),
    onArchive: async () => {
      const r = await structure.apply({ url: arcUrl(bookId, arc.slug, '/archive'), body: { base_sha256: arc.sha256 }, done: 'Arc archived.', undoable: true, after: () => onArchived?.() });
      if (!r.ok) {
        structure.showToast({ message: `Not changed: ${r.message}` });
        refresh();
      }
    },
  });

  async function create({ character, arc_type }) {
    const req = createArcRequest(bookId, { character, arc_type });
    const { status, json } = await track(bookId, () => send(req.url, req.body));
    if (isOk(status)) {
      structure.showToast({ message: 'Arc started.', opId: json?.opId ?? null });
      refresh();
      return { ok: true, slug: json?.slug ?? null };
    }
    return { ok: false, message: explainArcFailure(status, json) ?? explainFailure(status, json), existing: json?.code === 'REFUSED_DUPLICATE_ARC' ? (json?.existing?.slug ?? null) : null };
  }

  return { state, handlersFor, create };
}
