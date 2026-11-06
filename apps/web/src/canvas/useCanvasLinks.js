// The Flow links a canvas shows and writes (M09 canvas relations): GET /links once (and after each write), and the four writes of a scene-to-scene connection.
// Each write goes through the same routes as the Plan tab's Flow view, shows its result in the toast (with Undo where the server gives one) and reloads the links.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLinkRequest, isStaleWrite, linkUrl, linksUrl, reverseLinkBody, updateLinkBody } from '../planner/requests.js';
import { useWrites } from '../shell/writes.jsx';
import { send } from '../structure/helpers.js';
import { duplicateLinkSlug, explainCanvasLinkFailure, indexLinks } from './model.js';

const isOk = (status) => status === 200 || status === 201;

/**
 * @param {{ bookId: string, version?: string, showToast: (t: { message: string, opId?: string | null }) => void }} p `version` reloads the links when it changes
 * @returns {{ links: Map<string, any> | null, reload: () => Promise<void>,
 *   create: (v: { from: string, to: string, relation: string }) => Promise<{ ok: true, slug: string, adopted: boolean } | { ok: false, message: string }>,
 *   setRelation: (link: any, relation: string) => Promise<{ ok: boolean }>, reverse: (link: any) => Promise<{ ok: boolean }>, archive: (link: any) => Promise<{ ok: boolean }> }}
 */
export function useCanvasLinks({ bookId, version = '', showToast }) {
  const { track } = useWrites();
  const [links, setLinks] = useState(/** @type {Map<string, any> | null} */ (null));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** The live links by slug, or null when they cannot be read (the lines then keep their stored labels). */
  const fetchLinks = useCallback(async () => {
    try {
      const res = await fetch(linksUrl(bookId), { headers: { accept: 'application/json' } });
      return res.ok ? indexLinks(await res.json()) : null;
    } catch {
      return null;
    }
  }, [bookId]);
  const reload = useCallback(async () => {
    const next = await fetchLinks();
    if (next && alive.current) setLinks(next);
  }, [fetchLinks]);
  useEffect(() => {
    let stale = false;
    fetchLinks().then((next) => {
      if (next && !stale) setLinks(next);
    });
    return () => {
      stale = true;
    };
  }, [fetchLinks, version]);

  const write = (url, body) => track(bookId, () => send(url, body));

  /** One write that changes an existing link: toast and reload on success; a stale 409 reloads and asks to try again. */
  async function change(url, body, done) {
    const { status, json } = await write(url, body);
    if (isOk(status)) {
      showToast({ message: done, opId: json?.opId ?? null });
      await reload();
      return { ok: true };
    }
    await reload();
    showToast({ message: isStaleWrite(status, json) ? 'This link changed in Flow; reloaded. Try again.' : `Not changed: ${explainCanvasLinkFailure(status, json)}` });
    return { ok: false };
  }

  async function create(v) {
    const req = createLinkRequest(bookId, v);
    const { status, json } = await write(req.url, req.body);
    if (isOk(status) && typeof json?.slug === 'string') {
      showToast({ message: 'Link created in Flow.', opId: json?.opId ?? null });
      await reload();
      return { ok: true, slug: json.slug, adopted: false };
    }
    const existing = duplicateLinkSlug(status, json);
    if (existing) {
      showToast({ message: 'That link already exists in Flow; this line now shows it.' });
      await reload();
      return { ok: true, slug: existing, adopted: true };
    }
    const message = isOk(status) ? 'The link was made but the server did not name it. Reload the page.' : explainCanvasLinkFailure(status, json);
    showToast({ message: `Not changed: ${message}` });
    if (isOk(status)) await reload();
    return { ok: false, message };
  }

  return {
    links,
    reload,
    create,
    setRelation: (link, relation) => change(linkUrl(bookId, link.slug), updateLinkBody(link, { relation }), 'Link saved.'),
    reverse: (link) => change(linkUrl(bookId, link.slug), reverseLinkBody(link), 'Link reversed.'),
    archive: (link) => change(linkUrl(bookId, link.slug, '/archive'), { base_sha256: link.sha256 }, 'Link archived.'),
  };
}
