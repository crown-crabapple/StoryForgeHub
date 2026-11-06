import { useState } from 'react';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { createRelationshipRequest, developmentsBody, explainRelationshipFailure, isStaleWrite, relationshipUrl, updateRelationshipBody } from './requests.js';

const isOk = (status) => status === 200 || status === 201;

/**
 * The writes of relationships in the Plan tab's Lanes view. Each write goes with the sha256 last read, offers Undo in the toast (`structure.showToast`), and on a 409 says the
 * relationship changed elsewhere and reloads (`refresh`).
 * @param {{ bookId: string, structure: { showToast: Function, apply: Function }, refresh: () => void }} p
 * @returns {{ state: { slug: string | null, busy: boolean, message: string | null, error: string | null }, handlersFor: (rel: any, extra?: { onArchived?: () => void }) => any,
 *   create: (v: { a: string, b: string }) => Promise<{ ok: true, slug: string | null } | { ok: false, message: string, existing?: string | null }> }}
 */
export function useRelationshipWrites({ bookId, structure, refresh }) {
  const { track } = useWrites();
  const [state, setState] = useState({ slug: null, busy: false, message: null, error: null });

  async function write(rel, url, body, done) {
    setState({ slug: rel.slug, busy: true, message: null, error: null });
    const { status, json } = await track(bookId, () => send(url, body));
    if (isOk(status)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      setState({ slug: rel.slug, busy: false, message: null, error: null });
      refresh();
      return true;
    }
    const message = isStaleWrite(status, json) ? 'This relationship changed elsewhere; reloaded.' : null;
    setState({ slug: rel.slug, busy: false, message, error: message ? null : (explainRelationshipFailure(status, json) ?? explainFailure(status, json)) });
    refresh();
    return false;
  }

  /** @param {any} rel @param {{ onArchived?: () => void }} [extra] */
  const handlersFor = (rel, { onArchived } = {}) => ({
    onSaveField: (key, value) => write(rel, relationshipUrl(bookId, rel.slug), updateRelationshipBody(rel, { fields: { [key]: value } }), 'Relationship saved.'),
    onSaveNotes: (text) => write(rel, relationshipUrl(bookId, rel.slug), updateRelationshipBody(rel, { body: text }), 'Relationship notes saved.'),
    onSaveDevelopments: (list) => write(rel, relationshipUrl(bookId, rel.slug, '/developments'), developmentsBody(rel, list), 'Developments saved.'),
    onArchive: async () => {
      const r = await structure.apply({ url: relationshipUrl(bookId, rel.slug, '/archive'), body: { base_sha256: rel.sha256 }, done: 'Relationship archived.', undoable: true, after: () => onArchived?.() });
      if (!r.ok) {
        structure.showToast({ message: `Not changed: ${r.message}` });
        refresh();
      }
    },
  });

  async function create({ a, b }) {
    const req = createRelationshipRequest(bookId, { a, b });
    const { status, json } = await track(bookId, () => send(req.url, req.body));
    if (isOk(status)) {
      structure.showToast({ message: 'Relationship started.', opId: json?.opId ?? null });
      refresh();
      return { ok: true, slug: json?.slug ?? null };
    }
    return { ok: false, message: explainRelationshipFailure(status, json) ?? explainFailure(status, json), existing: json?.code === 'REFUSED_DUPLICATE_RELATIONSHIP' ? (json?.existing?.slug ?? null) : null };
  }

  return { state, handlersFor, create };
}
