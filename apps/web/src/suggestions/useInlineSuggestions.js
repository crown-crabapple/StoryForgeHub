// The pending suggestions of one document (a scene or a Codex entry), as the marks the editor draws inline (M05-J06 inline review).
// Loads the open suggestions for the target, then each one's detail (the hunks carry `body_line`, where their lines are in the text now). Loads again when `version` changes.
import { useEffect, useState } from 'react';
import { suggestionUrl, suggestionsUrl } from './model.js';

const EMPTY = { marks: [], fieldHunks: 0, staleCount: 0, firstId: null };

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  return res.ok ? res.json() : null;
}

/**
 * @param {{ bookId: string, target: { id: string, kind?: string } | null, enabled?: boolean, version?: string | number }} p
 * @returns {{ marks: any[], fieldHunks: number, staleCount: number, firstId: string | null }} `marks`: pending hunks with a body line, ready for setSuggestionMarks (without `canDecide`);
 *   `fieldHunks`: pending hunks that are not stale and not in the text (the front matter); `staleCount`: pending hunks that no longer fit; `firstId`: a suggestion those belong to.
 */
export function useInlineSuggestions({ bookId, target, enabled = true, version = '' }) {
  const [state, setState] = useState(EMPTY);
  const targetId = target?.id ?? null;
  const active = Boolean(enabled && bookId && targetId);
  useEffect(() => {
    if (!active) return undefined;
    const ctrl = new AbortController();
    (async () => {
      const list = await getJson(suggestionsUrl(bookId, { target: targetId, state: 'open' }), ctrl.signal);
      const open = list?.suggestions ?? [];
      const details = await Promise.all(open.map((s) => getJson(suggestionUrl(bookId, s.id), ctrl.signal)));
      const next = { marks: [], fieldHunks: 0, staleCount: 0, firstId: null };
      details.forEach((d, i) => {
        if (!d) return;
        for (const h of d.hunks ?? []) {
          if (h.status !== 'pending') continue;
          if (h.stale) {
            next.staleCount++;
            next.firstId ??= open[i].id;
          } else if (Number.isInteger(h.body_line)) {
            next.marks.push({ suggestionId: open[i].id, hunkId: h.id, line: h.body_line, lines: h.lines, originalLines: h.originalLines, newLines: h.newLines, rationale: d.rationale ?? '', by: d.by ?? null, source: d.source });
          } else {
            next.fieldHunks++;
            next.firstId ??= open[i].id;
          }
        }
      });
      setState(next);
    })().catch((e) => {
      if (e?.name !== 'AbortError') setState(EMPTY);
    });
    return () => ctrl.abort();
  }, [bookId, targetId, active, version]);
  return active ? state : EMPTY;
}
