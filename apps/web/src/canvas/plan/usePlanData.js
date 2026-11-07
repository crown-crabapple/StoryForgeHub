// The planner data the canvas shows (M10 C3/C4): one parallel read of the planner GET routes, kept as the raw JSON of each route, and read again when the book changes.
// Nothing is copied into the canvas file; cards and the rail read this.
import { useCallback, useEffect, useState } from 'react';
import { continuityUrl } from '../../continuity/requests.js';
import { cluesUrl } from '../../planner/clues.js';
import { branchNames } from '../../planner/model.js';
import { arcsUrl, flowUrl, linksUrl, relationshipsUrl, storyPlanUrl, structuresUrl } from '../../planner/requests.js';
import { synopsesUrl } from '../../planner/synopsis.js';
import { useModule } from '../../prefs/PrefsContext.jsx';
import { bookVersion, useStatus } from '../../status.jsx';
import { planFindings } from './selectors.js';

/** What a disabled or not yet loaded plan holds. */
const EMPTY = Object.freeze({ storyPlan: null, structures: null, arcs: null, relationships: null, synopses: null, clues: null, links: null, flow: null, continuity: null });

/** GET one route: the JSON, null on 404, and a thrown Error on any other failure. @param {string} url @param {AbortSignal} signal */
async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/**
 * @param {{ bookId: string, enabled: boolean }} p `enabled`: the planner module is on (nothing is fetched otherwise)
 * @returns {{ loading: boolean, error: string | null, storyPlan: any, structures: any, arcs: any, relationships: any, synopses: any, clues: any, links: any,
 *   findings: any[], branches: string[], scenes: { id: string, title?: string | null, chapter?: number | null }[], refresh: () => void }}
 *   `scenes` are the scenes of GET /flow in reading order (for chapter numbers); `findings` the plan-check findings (rules PL1 to PL6, [] with the continuity module off);
 *   a route that fails leaves its part null and the first failure in `error`.
 */
export function usePlanData({ bookId, enabled }) {
  const { status } = useStatus();
  const version = bookVersion(status, bookId);
  const continuityOn = useModule('continuity');
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  const [state, setState] = useState({ bookId: /** @type {string | null} */ (null), data: EMPTY, error: /** @type {string | null} */ (null) });

  useEffect(() => {
    if (!enabled) return undefined;
    const ctrl = new AbortController();
    const urls = {
      storyPlan: storyPlanUrl(bookId),
      structures: structuresUrl(bookId),
      arcs: arcsUrl(bookId),
      relationships: relationshipsUrl(bookId),
      synopses: synopsesUrl(bookId),
      clues: cluesUrl(bookId),
      links: linksUrl(bookId),
      flow: flowUrl(bookId),
      ...(continuityOn ? { continuity: continuityUrl(bookId) } : {}),
    };
    const keys = Object.keys(urls);
    Promise.allSettled(keys.map((k) => getJson(urls[k], ctrl.signal))).then((results) => {
      if (ctrl.signal.aborted) return;
      const data = { ...EMPTY };
      let error = null;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[keys[i]] = r.value;
        else error ??= r.reason?.message ?? 'Request failed';
      });
      setState({ bookId, data, error });
    });
    return () => ctrl.abort();
  }, [bookId, enabled, continuityOn, version, bump]);

  const ready = enabled && state.bookId === bookId;
  const d = ready ? state.data : EMPTY;
  return {
    loading: enabled && !ready,
    error: ready ? state.error : null,
    storyPlan: d.storyPlan,
    structures: d.structures,
    arcs: d.arcs,
    relationships: d.relationships,
    synopses: d.synopses,
    clues: d.clues,
    links: d.links,
    findings: planFindings(d.continuity),
    branches: branchNames(d.flow?.branches, d.links?.links),
    scenes: Array.isArray(d.flow?.nodes) ? d.flow.nodes.filter((n) => n?.kind !== 'beat') : [],
    refresh,
  };
}
