// Deep links into the Plan tab (M10 decision 8): `/plan?select=<id>` opens the canvas with that card picked. The older Plan-tab addresses (`?view=clues&clue=<slug>` and the like)
// still work: legacyPlanTarget reads them, resolvePlanTarget turns a slug into the permanent id from the loaded plan. Pure: no DOM, no network.

/** The plan objects a legacy address names by slug, with the plan list and key each one is found in. */
const SLUG_KINDS = [
  { param: 'structure', kind: 'structure', list: 'structures', key: 'structures' },
  { param: 'clue', kind: 'clue', list: 'clues', key: 'clues' },
  { param: 'arc', kind: 'arc', list: 'arcs', key: 'arcs' },
  { param: 'relationship', kind: 'relationship', list: 'relationships', key: 'relationships' },
  { param: 'synopsis', kind: 'synopsis', list: 'synopses', key: 'synopses' },
];

/**
 * What a Plan-tab query asks for, old forms included.
 * `select` is a ref id to pick (`?select=` first, else `view=flow&node=<scene id>`); `slug` is `{ kind, slug }` for an object named by slug (`structure`, `clue`, `arc`, `relationship`, `synopsis`);
 * `branch` a what-if branch slug; `series` is true for `view=series`. Anything else gives all nulls: the canvas just opens.
 * @param {string} [search]
 * @returns {{ select: string | null, slug: { kind: string, slug: string } | null, branch: string | null, series: boolean }}
 */
export function legacyPlanTarget(search = '') {
  const p = new URLSearchParams(search);
  const get = (k) => {
    const v = p.get(k);
    return v !== null && v !== '' ? v : null;
  };
  const branch = get('branch') === '*' ? null : get('branch'); // `*` (every branch) is not a branch the canvas can show
  const out = { select: get('select'), slug: null, branch, series: p.get('view') === 'series' };
  if (out.select !== null) return out;
  const node = get('node');
  if (p.get('view') === 'flow' && node !== null) return { ...out, select: node };
  for (const k of SLUG_KINDS) {
    const slug = get(k.param);
    if (slug !== null) return { ...out, slug: { kind: k.kind, slug } };
  }
  return out;
}

/**
 * The ref id (and structure) a target picks, with slugs looked up in the loaded plan. A slug the plan does not know gives `select: null` (the canvas just opens).
 * @param {ReturnType<typeof legacyPlanTarget>} target @param {any} plan the plan data of usePlanData
 * @returns {{ select: string | null, structureId: string | null, branch: string | null, series: boolean }}
 */
export function resolvePlanTarget(target, plan) {
  const base = { select: target.select, structureId: null, branch: target.branch, series: target.series };
  if (!target.slug) return base;
  const spec = SLUG_KINDS.find((k) => k.kind === target.slug.kind);
  const items = Array.isArray(plan?.[spec.list]?.[spec.key]) ? plan[spec.list][spec.key] : [];
  const found = items.find((x) => x?.slug === target.slug.slug);
  const id = typeof found?.id === 'string' ? found.id : null;
  return { ...base, select: id, structureId: spec.kind === 'structure' ? id : null };
}
