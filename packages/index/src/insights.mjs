// The Insights numbers of a book (M07-J02 section 3): one pure function from plain inputs to one JSON value.
// The inputs come either from the book's index (queries.insightsStructure) or from validate(), and the output is the same bytes either way:
// every list has a fixed order (manuscript order, then name, then id) and every object has sorted keys.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nameCmp = (a, b) => cmp(String(a.name ?? '').toLowerCase(), String(b.name ?? '').toLowerCase()) || cmp(a.id, b.id);

export const SCENE_STATUSES = ['outline', 'drafting', 'revised', 'final'];

// ---------------------------------------------------------------- dates (ISO strings, UTC arithmetic, no time zones)

/** @param {string} date @param {number} n */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** The Monday of the ISO week of `date`. @param {string} date */
export function weekStart(date) {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}
/** @param {string} date */
export const monthStart = (date) => `${date.slice(0, 7)}-01`;

/** The first day of a goal's period that contains `today`, or null for `total`. @param {string} period @param {string} today */
export function periodStart(period, today) {
  if (period === 'day') return today;
  if (period === 'week') return weekStart(today);
  if (period === 'month') return monthStart(today);
  return null;
}

/** Objects with their keys in code point order, all the way down (arrays keep their order). @param {any} v */
export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * @typedef {{ id: string, kind: string, period: string, target: number, due?: string, scope?: string }} GoalIn
 * @typedef {{ date: string, minutes: number, added: number, removed: number, kind: string, scenes: string[] }} SessionIn  `date` is the local date the session started
 * @typedef {{
 *   today: string,
 *   book: { id: string | null, title: string | null, word_target: number | null },
 *   scenes: { id: string, title: string | null, position: number, act: number, chapter: number, status: string | null, pov: string | null, word_count: number, path: string, labels: string[] }[],
 *   chapters: { act: number, chapter: number, label: string | null, title: string | null }[],
 *   containers: { id: string, kind: 'chapter' | 'act', dir: string }[],
 *   nodes: { id: string, kind: string, type: string | null, name: string | null, owner?: string, external?: boolean }[],
 *   edges: { from: string, to: string, kind: string, rel: string, location: string }[],
 *   labelDefs: { name: string, color: string }[],
 *   goals: GoalIn[], dailyWordGoal: number | null,
 *   days: { date: string, added: number, removed: number, net: number, minutes: number, sessions: number }[],
 *   sessions: SessionIn[],
 *   tasks: { status: string }[],
 * }} InsightInputs
 */

const dir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** @param {InsightInputs} inp */
export function computeInsights(inp) {
  const { today } = inp;
  const scenes = [...inp.scenes].sort((a, b) => a.position - b.position || cmp(a.id, b.id));
  const chapters = inp.chapters;
  const chapterKey = (s) => `${s.act}/${s.chapter}`;
  const chapterIndex = new Map(chapters.map((c, i) => [`${c.act}/${c.chapter}`, i]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const totalWords = scenes.reduce((n, s) => n + s.word_count, 0);

  // ------------------------------------------------------------ goals
  const scopeScenes = (scope) => {
    if (!scope) return null;
    const c = inp.containers.find((x) => x.id === scope);
    if (!c) return new Set();
    return new Set(scenes.filter((s) => (c.kind === 'chapter' ? dir(s.path) === c.dir : s.path.startsWith(`${c.dir}/`))).map((s) => s.id));
  };
  const logByDate = new Map(inp.days.map((d) => [d.date, d]));
  const sessByDate = new Map();
  for (const r of inp.sessions) {
    if (!sessByDate.has(r.date)) sessByDate.set(r.date, []);
    sessByDate.get(r.date).push(r);
  }
  const inRange = (date, from, to) => (from === null || date >= from) && date <= to;
  const datesIn = (from, to) => {
    const set = new Set();
    for (const d of logByDate.keys()) if (inRange(d, from, to)) set.add(d);
    for (const d of sessByDate.keys()) if (inRange(d, from, to)) set.add(d);
    return [...set].sort();
  };

  /** The value of a goal over the days from `from` (null = the beginning) to `to`. */
  function valueOf(g, from, to) {
    const S = scopeScenes(g.scope);
    const rows = [];
    for (const d of datesIn(from, to)) for (const r of sessByDate.get(d) ?? []) if (!S || r.scenes.some((id) => S.has(id))) rows.push({ ...r });
    if (g.period === 'total' && (g.kind === 'words' || g.kind === 'scenes' || g.kind === 'chapters') ) {
      const own = S ? scenes.filter((s) => S.has(s.id)) : scenes;
      if (g.kind === 'words') return own.reduce((n, s) => n + s.word_count, 0);
      if (g.kind === 'scenes') return own.filter((s) => s.status === 'final').length;
      const byChapter = new Map();
      for (const s of own) {
        const k = chapterKey(s);
        byChapter.set(k, (byChapter.get(k) ?? true) && s.status === 'final');
      }
      return [...byChapter.values()].filter(Boolean).length;
    }
    if (g.kind === 'words') {
      if (!S) return Math.max(0, datesIn(from, to).reduce((n, d) => n + (logByDate.get(d)?.net ?? 0), 0));
      return Math.max(0, rows.reduce((n, r) => n + r.added - r.removed, 0));
    }
    if (g.kind === 'minutes') {
      if (S) return rows.reduce((n, r) => n + r.minutes, 0);
      let n = 0;
      for (const d of datesIn(from, to)) n += Math.max(logByDate.get(d)?.minutes ?? 0, (sessByDate.get(d) ?? []).reduce((m, r) => m + r.minutes, 0));
      return n;
    }
    const ids = new Set(rows.flatMap((r) => r.scenes).filter((id) => sceneById.has(id) && (!S || S.has(id))));
    if (g.kind === 'scenes') return ids.size;
    return new Set([...ids].map((id) => chapterKey(sceneById.get(id)))).size;
  }

  // the chapters and acts a goal can be scoped to, by name (a container with no scenes keeps its id as its name)
  const scopes = inp.containers
    .map((c) => {
      const inside = scenes.filter((s) => (c.kind === 'chapter' ? dir(s.path) === c.dir : s.path.startsWith(`${c.dir}/`)));
      const first = inside[0];
      const ch = first ? chapters[chapterIndex.get(chapterKey(first))] : null;
      const name = c.kind === 'chapter' ? (ch ? (ch.title ? `${ch.label ?? `Chapter ${ch.chapter}`}: ${ch.title}` : (ch.label ?? `Chapter ${ch.chapter}`)) : c.id) : first ? `Act ${first.act}` : c.id;
      return { id: c.id, kind: c.kind, name, at: first ? first.position : Infinity };
    })
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'act' ? -1 : 1) || a.at - b.at || cmp(a.id, b.id))
    .map((x) => ({ id: x.id, kind: x.kind, name: x.name }));
  const earliest = [...logByDate.keys(), ...sessByDate.keys()].sort()[0] ?? today;
  function streakOf(g) {
    if (g.period !== 'day') return 0;
    const met = (d) => valueOf(g, d, d) >= g.target;
    let day = met(today) ? today : addDays(today, -1);
    let n = 0;
    while (day >= earliest && met(day)) {
      n++;
      day = addDays(day, -1);
    }
    return n;
  }

  const goalsIn = [...inp.goals];
  if (inp.dailyWordGoal && !goalsIn.some((g) => g.kind === 'words' && g.period === 'day')) {
    goalsIn.unshift({ id: 'daily_word_goal', kind: 'words', period: 'day', target: inp.dailyWordGoal, legacy: true });
  }
  const last30 = (() => {
    let n = 0;
    for (let i = 0; i < 30; i++) n += logByDate.get(addDays(today, -i))?.net ?? 0;
    return n;
  })();
  const goals = goalsIn.map((g) => {
    const from = periodStart(g.period, today);
    const value = valueOf(g, from, today);
    const scopeName = g.scope ? (inp.containers.find((c) => c.id === g.scope) ? g.scope : null) : null;
    const out = {
      id: g.id, kind: g.kind, period: g.period, target: g.target, value,
      percent: Math.min(100, Math.floor((100 * value) / g.target)), met: value >= g.target,
      scope: g.scope ?? null, scope_found: g.scope ? scopeName !== null : true, scope_name: scopes.find((x) => x.id === g.scope)?.name ?? null,
      due: g.due ?? null, legacy: g.legacy === true,
      period_start: from, streak: streakOf(g), projected_finish: null, on_track: null, reached: g.period === 'total' && value >= g.target,
    };
    if (g.kind === 'words' && g.period === 'total' && g.due && !out.reached && last30 > 0) {
      const finish = addDays(today, Math.ceil((g.target - value) / (last30 / 30)));
      out.projected_finish = finish;
      out.on_track = finish <= g.due;
    }
    return out;
  });
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const date = addDays(today, -i);
    const d = logByDate.get(date);
    days.push({ date, added: d?.added ?? 0, removed: d?.removed ?? 0, net: d?.net ?? 0, minutes: d?.minutes ?? 0, sessions: d?.sessions ?? 0 });
  }

  // ------------------------------------------------------------ manuscript
  const perChapter = chapters.map((c) => ({ act: c.act, chapter: c.chapter, label: c.label, title: c.title, words: 0, scenes: 0, final: 0 }));
  for (const s of scenes) {
    const row = perChapter[chapterIndex.get(chapterKey(s))];
    if (!row) continue;
    row.words += s.word_count;
    row.scenes += 1;
    if (s.status === 'final') row.final += 1;
  }
  const statuses = new Map(SCENE_STATUSES.map((k) => [k, { status: k, scenes: 0, words: 0 }]));
  for (const s of scenes) {
    const k = s.status ?? '(none)';
    if (!statuses.has(k)) statuses.set(k, { status: k, scenes: 0, words: 0 });
    const row = statuses.get(k);
    row.scenes += 1;
    row.words += s.word_count;
  }
  const statusRows = [...statuses.values()].sort((a, b) => {
    const ia = SCENE_STATUSES.indexOf(a.status);
    const ib = SCENE_STATUSES.indexOf(b.status);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || cmp(a.status, b.status);
  });
  const labelRows = new Map();
  for (const l of inp.labelDefs) labelRows.set(l.name.trim().toLowerCase(), { label: l.name, color: l.color, scenes: 0, words: 0, defined: true });
  let unlabeled = 0;
  for (const s of scenes) {
    if (s.labels.length === 0) unlabeled++;
    for (const name of new Set(s.labels.map((x) => x.trim().toLowerCase()))) {
      if (!labelRows.has(name)) labelRows.set(name, { label: s.labels.find((x) => x.trim().toLowerCase() === name), color: null, scenes: 0, words: 0, defined: false });
      const row = labelRows.get(name);
      row.scenes += 1;
      row.words += s.word_count;
    }
  }
  const nodeById = new Map(inp.nodes.map((n) => [n.id, n]));
  const povEdge = new Map();
  for (const e of inp.edges) if (e.rel === 'pov' && sceneById.has(e.from) && !povEdge.has(e.from)) povEdge.set(e.from, e.to);
  const povRows = new Map();
  for (const s of scenes) {
    const target = povEdge.get(s.id);
    const key = target ?? (s.pov ? `text:${s.pov}` : 'none');
    if (!povRows.has(key)) {
      const node = target ? nodeById.get(target) : null;
      povRows.set(key, { id: target ?? null, name: node?.name ?? s.pov ?? null, pov: s.pov ?? null, scenes: 0, words: 0, shared: node?.owner === 'series' });
    }
    const row = povRows.get(key);
    row.scenes += 1;
    row.words += s.word_count;
  }
  const pov = [...povRows.values()]
    .map((r) => ({ ...r, share: totalWords > 0 ? Math.round((1000 * r.words) / totalWords) / 10 : 0 }))
    .sort((a, b) => b.words - a.words || nameCmp({ id: a.id ?? '', name: a.name }, { id: b.id ?? '', name: b.name }));

  // ------------------------------------------------------------ story
  // scenes each node is linked with, either way round (an entry named in a scene, or a scene named in an entry, a thread or an event)
  const byNode = new Map();
  for (const e of inp.edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      if (!sceneById.has(b)) continue;
      if (!byNode.has(a)) byNode.set(a, new Set());
      byNode.get(a).add(b);
    }
  }
  const characters = inp.nodes.filter((n) => n.kind === 'entry' && n.type === 'character' && !n.external).sort(nameCmp);
  const heat = [];
  let withoutScenes = 0;
  for (const c of characters) {
    const cells = chapters.map(() => 0);
    for (const sid of byNode.get(c.id) ?? []) {
      const i = chapterIndex.get(chapterKey(sceneById.get(sid)));
      if (i !== undefined) cells[i] += 1;
    }
    const total = cells.reduce((n, x) => n + x, 0);
    if (total === 0) withoutScenes++;
    else heat.push({ id: c.id, name: c.name, shared: c.owner === 'series', total, cells });
  }

  const threadRoles = new Map(); // thread id -> scene id -> { S, D, P }
  const threadLinked = new Map();
  const roleOf = (loc) => (loc.startsWith('setup[') ? 'S' : loc.startsWith('develop[') ? 'D' : loc.startsWith('payoff[') ? 'P' : null);
  for (const e of inp.edges) {
    if (e.kind !== 'explicit') continue;
    const fromThread = nodeById.get(e.from)?.kind === 'thread';
    if (fromThread && sceneById.has(e.to)) {
      const role = roleOf(e.location);
      if (!role) continue;
      if (!threadRoles.has(e.from)) threadRoles.set(e.from, new Map());
      const m = threadRoles.get(e.from);
      if (!m.has(e.to)) m.set(e.to, new Set());
      m.get(e.to).add(role);
    } else if (e.rel === 'thread' && sceneById.has(e.from) && nodeById.get(e.to)?.kind === 'thread') {
      if (!threadLinked.has(e.to)) threadLinked.set(e.to, new Set());
      threadLinked.get(e.to).add(e.from);
    }
  }
  const threadRows = inp.nodes.filter((n) => n.kind === 'thread' && !n.external).sort((a, b) => nameCmp({ id: a.id, name: a.name }, { id: b.id, name: b.name })).map((t) => {
    const cells = chapters.map(() => [0, 0, 0, 0]); // planted, developed, paid, only listed on the scene
    const roles = threadRoles.get(t.id) ?? new Map();
    for (const [sid, set] of roles) {
      const i = chapterIndex.get(chapterKey(sceneById.get(sid)));
      if (i === undefined) continue;
      if (set.has('S')) cells[i][0] += 1;
      if (set.has('D')) cells[i][1] += 1;
      if (set.has('P')) cells[i][2] += 1;
    }
    for (const sid of threadLinked.get(t.id) ?? []) {
      if (roles.has(sid)) continue;
      const i = chapterIndex.get(chapterKey(sceneById.get(sid)));
      if (i !== undefined) cells[i][3] += 1;
    }
    const sum = (k) => cells.reduce((n, c) => n + c[k], 0);
    return { id: t.id, title: t.name, planted: sum(0), developed: sum(1), paid: sum(2), linked: sum(3), cells };
  });

  const related = new Map();
  for (const e of inp.edges) {
    if (e.rel !== 'related') continue;
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      if (!related.has(a)) related.set(a, new Set());
      related.get(a).add(b);
    }
  }
  const relationships = characters
    .map((c) => ({ id: c.id, name: c.name, shared: c.owner === 'series', count: related.get(c.id)?.size ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || nameCmp(a, b));

  const eventsIn = chapters.map(() => new Set());
  const placed = new Set();
  const eventNodes = inp.nodes.filter((n) => n.kind === 'event' && !n.external);
  const eventIds = new Set(eventNodes.map((n) => n.id));
  for (const e of inp.edges) {
    const [ev, sc] = eventIds.has(e.from) ? [e.from, e.to] : eventIds.has(e.to) ? [e.to, e.from] : [null, null];
    if (ev === null || !sceneById.has(sc)) continue;
    const i = chapterIndex.get(chapterKey(sceneById.get(sc)));
    if (i === undefined) continue;
    eventsIn[i].add(ev);
    placed.add(ev);
  }

  const taskCount = (status) => inp.tasks.filter((t) => t.status === status).length;

  return sortKeys({
    schema: 'storyforge.insights/v1',
    as_of: today,
    book: { id: inp.book.id, title: inp.book.title, word_target: inp.book.word_target, words: totalWords, scenes: scenes.length },
    progress: { goals, days, scopes },
    manuscript: {
      chapters: perChapter,
      scenes: scenes.map((s) => ({ id: s.id, title: s.title, act: s.act, chapter: s.chapter, position: s.position, words: s.word_count, status: s.status, pov: s.pov })),
      status: statusRows,
      labels: { rows: [...labelRows.values()].sort((a, b) => b.scenes - a.scenes || cmp(a.label.toLowerCase(), b.label.toLowerCase())), unlabeled },
      pov,
    },
    story: {
      chapters: chapters.map((c) => ({ act: c.act, chapter: c.chapter, label: c.label })),
      characters: { rows: heat, without_scenes: withoutScenes },
      threads: { rows: threadRows },
      relationships,
      events: {
        by_chapter: chapters.map((c, i) => ({ act: c.act, chapter: c.chapter, label: c.label, events: eventsIn[i].size })),
        total: eventNodes.length,
        unplaced: eventNodes.length - placed.size,
      },
    },
    tasks: { open: taskCount('open'), doing: taskCount('doing'), done: taskCount('done'), dropped: taskCount('dropped'), total: inp.tasks.length },
  });
}
