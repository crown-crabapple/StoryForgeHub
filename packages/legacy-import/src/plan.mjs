// planImport: a legacy dump in, a complete import plan out (every destination file with its exact bytes, a disposition for every legacy row,
// issues, a summary). Pure planning: it reads the dump directory and nothing else, and writes nothing. Deterministic: the same dump always
// gives the same plan (IDs are derived from table + legacy id, never random; no clocks, no paths of the dump directory).
import { colText, isB64, lossy, readDump } from './dump.mjs';
import { legacySceneHash, sceneTitle, splitChapter } from './split.mjs';
import { byCodePoint, chRef, compareIds, compareKeys, deterministicId, frontMatter, numKey, pad, sha256Hex, slugify } from './util.mjs';

export const IMPORTER_VERSION = 1;

const TYPE_OF_DB = {
  characters: 'character', locations: 'location', factions: 'faction', objects: 'object', lore: 'lore', concepts: 'concept', people: 'person',
  sources: 'source', organizations: 'organization', methods: 'method', exercises: 'exercise', places: 'place', themes: 'theme',
};
const SERVER_ONLY_TABLES = new Set(['users', 'invites', 'password_resets', 'api_tokens', 'book_members', 'book_activity', 'editing_locks']);
const DERIVED_TABLES = new Set(['mentions', 'prose_analysis', 'claim_sources', 'exercises', 'threads', 'sync_state', 'scenes']);
const KNOWN_TABLES = new Set([
  'books', 'acts', 'chapters', 'entries', 'entry_fields', 'entry_sections', 'entry_relations', 'sources', 'note_pages', 'meta_pages', 'workspace_docs',
  'progressions', 'state_events', 'knowledge_facts', 'story_ledger', 'chapter_cast', 'continuity_exemptions', 'tasks', 'task_steps', 'writing_log',
  'chapter_notes', 'canvas_cards', 'canvas_links', 'vision_items', 'captures', 'dictionary_terms', 'chapter_revisions', 'entry_revisions',
  'workspace_revisions', ...SERVER_ONLY_TABLES, ...DERIVED_TABLES,
]);
const isServerOnly = (t) => SERVER_ONLY_TABLES.has(t) || t.startsWith('oauth_');
const SCENE_STATUS = { outline: 'outline', drafted: 'drafting', revised: 'revised' };
const LABEL_STATUS = { 'Draft 1': 'drafting', 'Needs revision': 'drafting', Final: 'final' };
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const STATE_TYPES = {
  died: { slug: ['character'] }, revived: { slug: ['character'] }, destroyed: {}, lost: {}, found: {},
  holder: { slug: ['object'], value: ['character'] }, location: { slug: ['character', 'object'], value: ['location'] },
};
const STATE_VALUED = new Set(['holder', 'location']);

const str = (row, key) => colText(row[key]);
const idOf = (row, index) => (row.id !== undefined && row.id !== null ? String(row.id) : String(index + 1));
const numOr = (v, d) => {
  const n = Number(colText(v));
  return colText(v) !== '' && Number.isFinite(n) ? n : d;
};
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

/** @param {string} dumpDir @param {{ books?: string[] }} [options] */
export function planImport(dumpDir, options = {}) {
  const dump = readDump(dumpDir);
  const issues = [...dump.issues];
  const issue = (severity, code, message, extra = {}) => issues.push({ severity, code, ...extra, message });

  // ---- tables, rows, dispositions -------------------------------------------------------------------------------------------------
  /** @type {Map<string, any[]>} */
  const rowsOf = new Map();
  for (const [name, t] of dump.tables) rowsOf.set(name, t.rows.map((r, i) => ({ row: r, id: idOf(r, i), raw: t.raw[i], index: i })));
  const R = (name) => rowsOf.get(name) ?? [];
  /** @type {Map<string, any>} */
  const dispositions = new Map();
  const dkey = (table, id) => `${table}\u0000${id}`;
  const setDisposition = (table, id, disposition, target, reason) => {
    const k = dkey(table, id);
    if (dispositions.has(k)) return;
    dispositions.set(k, { table, id, disposition, ...(target ? { target } : {}), ...(reason ? { reason } : {}) });
  };
  const users = new Map(R('users').map((u) => [String(u.row.id), str(u.row, 'display_name')]));
  const userName = (id) => (id === null || id === undefined || id === '' ? '' : users.get(String(id)) ?? '');

  for (const r of R('books')) if (!str(r.row, 'title') && !str(r.row, 'folder')) issue('warning', 'book-untitled', 'a book row has neither a title nor a folder', { table: 'books', id: r.id });

  // ---- which books ---------------------------------------------------------------------------------------------------------------
  const usedBookSlugs = new Set();
  const allBooks = R('books').map((b) => {
    const base = slugify(str(b.row, 'folder')) || slugify(b.id) || slugify(str(b.row, 'title')) || 'book';
    let slug = base;
    for (let n = 2; usedBookSlugs.has(slug); n++) slug = `${base.slice(0, 56)}-${n}`;
    usedBookSlugs.add(slug);
    return { r: b, legacy_id: b.id, slug, title: str(b.row, 'title') || slug };
  });
  const wanted = options.books && options.books.length ? options.books : null;
  const selected = wanted
    ? allBooks.filter((b) => wanted.some((w) => w === b.legacy_id || w === str(b.r.row, 'folder') || w === b.slug || slugify(w) === b.slug))
    : allBooks;
  if (wanted) {
    for (const w of wanted) {
      if (!allBooks.some((b) => w === b.legacy_id || w === str(b.r.row, 'folder') || w === b.slug || slugify(w) === b.slug)) issue('error', 'book-not-found', `no legacy book matches "${w}"`);
    }
  }
  const selectedIds = new Set(selected.map((b) => b.legacy_id));

  // owner book of a row (null: not tied to a book)
  const entryBook = new Map(R('entries').map((e) => [e.id, str(e.row, 'book_id')]));
  const taskBook = new Map(R('tasks').map((e) => [e.id, str(e.row, 'book_id')]));
  const chapterBook = new Map(R('chapters').map((e) => [e.id, str(e.row, 'book_id')]));
  const bookOfRow = (table, row) => {
    if (table === 'books') return str(row, 'id');
    if (['entry_fields', 'entry_sections', 'entry_relations'].includes(table)) return entryBook.get(str(row, 'entry_id')) ?? null;
    if (table === 'task_steps') return taskBook.get(str(row, 'task_id')) ?? null;
    if (['scenes', 'exercises', 'prose_analysis', 'chapter_revisions'].includes(table) && row.chapter_id !== undefined && !str(row, 'book_id')) return chapterBook.get(str(row, 'chapter_id')) ?? null;
    if (row.book_id !== undefined && str(row, 'book_id') !== '') return str(row, 'book_id');
    return null;
  };
  const firstBook = selected[0] ?? null;

  const builders = new Map(); // legacy book id -> builder
  const files = new Map(); // legacy book id -> Map<path, file>
  const chapterInfo = []; // exposed for the split invariant
  const newFileSets = (b) => {
    files.set(b.legacy_id, new Map());
    return files.get(b.legacy_id);
  };
  for (const b of selected) newFileSets(b);

  const kept = new Map(); // `${bookId}\u0000${table}` -> { rows: [...] } for legacy/tables files

  const addFile = (b, relPath, content, kind, sources) => {
    const set = files.get(b.legacy_id);
    let p = `${b.slug}/${relPath}`;
    if (set.has(p)) {
      const dot = p.lastIndexOf('.');
      for (let n = 2; ; n++) {
        const cand = `${p.slice(0, dot)}-${n}${p.slice(dot)}`;
        if (!set.has(cand)) {
          p = cand;
          break;
        }
      }
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    set.set(p, { path: p, bytes, sha256: sha256Hex(bytes), kind, sources: sources.map((s) => ({ table: s.table, id: String(s.id) })) });
    return p;
  };
  const keepRow = (b, table, rec, reason) => {
    const k = `${b.legacy_id}\u0000${table}`;
    if (!kept.has(k)) kept.set(k, { book: b, table, recs: [] });
    kept.get(k).recs.push(rec);
    return reason;
  };

  // ---- per book ----------------------------------------------------------------------------------------------------------------------
  for (const b of selected) {
    const bid = b.legacy_id;
    const mine = (table) => R(table).filter((r) => bookOfRow(table, r.row) === bid);
    const root = `${b.slug}/`;
    const B = { b, bid };
    builders.set(bid, B);

    // -------- chapters: order, numbers, acts --------
    const allCh = mine('chapters');
    const readmes = allCh.filter((c) => /readme\.md$/i.test(str(c.row, 'file')));
    const realCh = allCh.filter((c) => !readmes.includes(c));
    const isArchived = (c) => str(c.row, 'status') === 'archived';
    const byOrder = (list) => {
      const sorted = [...list].sort((x, y) => numOr(x.row.sort_order, 9999) - numOr(y.row.sort_order, 9999) || compareKeys(numKey(str(x.row, 'num')), numKey(str(y.row, 'num'))) || compareIds(x.id, y.id));
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1];
        const c = sorted[i];
        if (numOr(a.row.sort_order, 9999) === numOr(c.row.sort_order, 9999) && compareKeys(numKey(str(a.row, 'num')), numKey(str(c.row, 'num'))) === 0) {
          issue('warning', 'chapter-order-tie', `chapters ${a.id} and ${c.id} tie on sort_order and number ("${str(c.row, 'num')}"); the lower id comes first`, { table: 'chapters', id: c.id });
        }
      }
      return sorted;
    };
    const live = byOrder(realCh.filter((c) => !isArchived(c)));
    const archived = byOrder(realCh.filter(isArchived));

    const acts = mine('acts').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id));
    const actNoOfId = new Map(acts.map((a, i) => [a.id, i + 1]));
    const actFolder = new Map();
    acts.forEach((a, i) => actFolder.set(i + 1, `act-${pad(i + 1, 2)}-${slugify(str(a.row, 'title')) || 'act'}`));
    if (acts.length === 0) actFolder.set(1, 'act-01-manuscript');

    const chapters = []; // chapter records in book order (live first, then archived)
    let prevAct = null;
    let n = 0;
    for (const c of [...live, ...archived]) {
      n += 1;
      const arch = isArchived(c);
      let act = actNoOfId.get(str(c.row, 'act_id')) ?? null;
      if (act === null) {
        act = prevAct ?? 1;
        if (acts.length > 0) issue('info', 'chapter-without-act', `chapter ${c.id} has no act; it is placed in act ${act}`, { table: 'chapters', id: c.id });
      } else if (!arch && prevAct !== null && act < prevAct) {
        issue('warning', 'act-order-conflict', `chapter ${c.id} belongs to act ${act} but follows a chapter in act ${prevAct}; it is placed in act ${prevAct} so the manuscript order stays valid`, { table: 'chapters', id: c.id });
        act = prevAct;
      }
      if (!arch) prevAct = Math.max(prevAct ?? 1, act);
      if (!actFolder.has(act)) actFolder.set(act, `act-${pad(act, 2)}-act`);
      const title = str(c.row, 'title');
      const num = str(c.row, 'num');
      const cslug = slugify(title) || slugify(`chapter-${num}`) || 'chapter';
      const dir = `${arch ? 'archive/' : ''}manuscript/${actFolder.get(act)}/ch-${pad(n, 3)}-${cslug}`;
      chapters.push({ c, n, act, arch, title, num, dir, id: deterministicId('chap', 'chapters', c.id), cslug, scenes: [], body: str(c.row, 'body'), file: str(c.row, 'file') });
      if (isB64(c.row.body) && lossy(c.row.body)) issue('warning', 'invalid-utf8', `chapter ${c.id} holds bytes that are not valid UTF-8; they are shown as U+FFFD in the manuscript and kept exactly in legacy/tables/chapters-invalid-utf8.jsonl`, { table: 'chapters', id: c.id });
    }
    B.chapters = chapters;
    const chapterByDbId = new Map(chapters.map((c) => [c.c.id, c]));
    const chapterByFile = new Map(chapters.map((c) => [c.file, c]));
    /** a legacy chapter reference string -> chapter record (live first) */
    const chapterByRef = (s) => {
      const r = chRef(s);
      if (r === null || r === '') return null;
      return chapters.find((c) => !c.arch && chRef(c.num) === r) ?? chapters.find((c) => chRef(c.num) === r) ?? null;
    };

    // -------- scenes (ids, split, scenes cache) --------
    const cacheRows = mine('scenes');
    for (const ch of chapters) {
      const segs = splitChapter(ch.body);
      const cache = cacheRows.filter((r) => str(r.row, 'chapter_id') === ch.c.id).sort((x, y) => numOr(x.row.ordinal, 0) - numOr(y.row.ordinal, 0) || compareIds(x.id, y.id));
      const trusted = cache.length === segs.length && segs.length > 0 && segs.every((s, i) => str(cache[i].row, 'body_hash') === legacySceneHash(s.body));
      const hasData = cache.some((r) => str(r.row, 'label') !== '' || str(r.row, 'summary') !== '');
      if (!trusted && hasData) issue('info', 'scenes-cache-dropped', `the legacy scenes cache for chapter ${ch.c.id} does not match its ${segs.length} segment(s), so its labels and summaries were not applied`, { table: 'chapters', id: ch.c.id });
      ch.cache = trusted ? cache : [];
      ch.cacheAll = cache;
      ch.scenes = segs.map((s, i) => {
        const o = i + 1;
        const t = sceneTitle(s.body);
        if (s.kind === 'comment-only') issue('info', 'scene-comment-only', `segment ${o} of chapter ${ch.c.id} holds only a comment; it is kept as its own scene`, { table: 'chapters', id: ch.c.id });
        else if (s.kind === 'heading-only') issue('info', 'scene-heading-only', `segment ${o} of chapter ${ch.c.id} holds only a heading; it is kept as its own scene`, { table: 'chapters', id: ch.c.id });
        else if (s.kind === 'empty') issue('info', 'scene-empty', `segment ${o} of chapter ${ch.c.id} is empty; it is kept as an empty scene`, { table: 'chapters', id: ch.c.id });
        return {
          ...s, ordinal: o, sequence: o * 10, id: deterministicId('scene', 'chapters/scene', `${ch.c.id}#${o}`),
          title: t || `${ch.title || ch.num ? (ch.title || `Chapter ${ch.num}`) : `Chapter ${ch.n}`} — part ${o}`, cached: trusted ? cache[i] : null,
        };
      });
      if (segs.length === 0 && ch.body === '') issue('info', 'chapter-empty', `chapter ${ch.c.id} has an empty body; only its chapter.md is planned`, { table: 'chapters', id: ch.c.id });
      if (ch.arch) issue('info', 'chapter-archived', `chapter ${ch.c.id} is archived; it is planned under archive/`, { table: 'chapters', id: ch.c.id });
      chapterInfo.push({ legacy_id: ch.c.id, book: b.slug, chapter: ch.n, act: ch.act, num: ch.num, title: ch.title, body_bytes: Buffer.byteLength(ch.body, 'utf8'), body_sha256: sha256Hex(Buffer.from(ch.body, 'utf8')), archived: ch.arch, path: `${root}${ch.dir}/` });
    }
    const firstSceneId = (ch) => ch?.scenes.find((s) => !s.variantOf)?.id ?? ch?.scenes[0]?.id ?? null;

    // -------- entries and the shared slug space (entries, threads, events) --------
    const slugs = new Map(); // current slug -> owner key
    const claim = (wanted, owner) => {
      let slug = (wanted || 'item').slice(0, 60).replace(/-+$/g, '') || 'item';
      const base = slug;
      let collided = false;
      for (let k = 2; slugs.has(slug); k++) {
        collided = true;
        const suffix = `-${k}`;
        slug = `${base.slice(0, 60 - suffix.length).replace(/-+$/g, '')}${suffix}`;
      }
      slugs.set(slug, owner);
      return { slug, collided };
    };
    const entries = mine('entries').map((e) => {
      const db = str(e.row, 'db_key');
      const type = TYPE_OF_DB[db] ?? (db.toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '') || 'entry');
      const legacySlug = str(e.row, 'slug');
      const norm = slugify(legacySlug) || slugify(str(e.row, 'name')) || 'entry';
      const { slug, collided } = claim(norm, `entry:${e.id}`);
      if (collided) issue('warning', 'slug-collision', `entry ${e.id} (${db}/${legacySlug}) shares its slug with another entry, thread or event; it becomes "${slug}" and keeps "${legacySlug}" in previous_slugs`, { table: 'entries', id: e.id });
      else if (norm !== legacySlug) issue('info', 'slug-normalised', `entry ${e.id}: slug "${legacySlug}" becomes "${slug}"`, { table: 'entries', id: e.id });
      return { e, db, type, legacySlug, slug, id: deterministicId('entry', 'entries', e.id), prev: legacySlug !== slug && legacySlug !== '' && !legacySlug.includes(':') ? legacySlug : null, folder: type === 'lore' ? 'lore' : `${type}s` };
    });
    const entryByLegacy = new Map(); // legacy slug -> entry (the first one wins)
    for (const en of entries) if (!entryByLegacy.has(en.legacySlug)) entryByLegacy.set(en.legacySlug, en);
    const entryByCurrent = new Map(entries.map((en) => [en.slug, en]));
    const findEntry = (legacySlug) => entryByLegacy.get(legacySlug) ?? entryByLegacy.get(slugify(legacySlug)) ?? entryByCurrent.get(slugify(legacySlug)) ?? null;

    // -------- threads (story_ledger) slugs --------
    const ledger = mine('story_ledger').sort((x, y) => compareIds(x.id, y.id)).map((l) => {
      const legacySlug = str(l.row, 'slug');
      const { slug, collided } = claim(slugify(legacySlug) || slugify(str(l.row, 'title')) || 'thread', `thread:${l.id}`);
      if (collided) issue('warning', 'slug-collision', `ledger item ${l.id} ("${legacySlug}") shares its slug with another entry, thread or event; it becomes "${slug}"`, { table: 'story_ledger', id: l.id });
      return { l, legacySlug, slug, id: deterministicId('thread', 'story_ledger', l.id), prev: legacySlug !== slug && legacySlug !== '' ? legacySlug : null };
    });
    const threadByLegacy = new Map(ledger.map((t) => [t.legacySlug, t]));

    // -------- events: progressions + chapter buckets for state events and knowledge --------
    const events = [];
    const progs = mine('progressions').sort((x, y) => compareIds(x.id, y.id));
    progs.forEach((p, i) => {
      const what = str(p.row, 'what');
      const title = clip(oneLine(what).replace(/\*\*/g, ''), 80) || `Progression ${p.id}`;
      const ch = chapterByRef(str(p.row, 'chapter'));
      if (str(p.row, 'chapter') !== '' && !ch) issue('warning', 'chapter-ref-unresolved', `progression ${p.id} names chapter "${str(p.row, 'chapter')}", which matches no chapter; it has no scene link`, { table: 'progressions', id: p.id });
      const whenOrder = p.row.when_order !== undefined && colText(p.row.when_order) !== '' ? numOr(p.row.when_order, null) : null;
      events.push({
        kind: 'prog', key: `p${p.id}`, p, title, what, ch, order: whenOrder ?? numOr(p.row.sort_order, i + 1), when: str(p.row, 'when_label'), type: str(p.row, 'type'),
        chapterLabel: str(p.row, 'chapter'), sources: [{ table: 'progressions', id: p.id }], state: [], notes: [], extraChars: [], extraLocs: [],
        base: slugify(title.replace(/['’]/g, '')) || 'event', id: deterministicId('event', 'progressions', p.id),
      });
    });
    const bucket = (key, make) => {
      let ev = events.find((x) => x.key === key);
      if (!ev) {
        ev = { ...make(), key, state: [], notes: [], extraChars: [], extraLocs: [], sources: [], what: '', chapterLabel: '', type: '' };
        events.push(ev);
      }
      return ev;
    };
    /** the event a chapter's state changes hang on: the first progression event of that chapter, else a created legacy-chapter-<n> event */
    const eventForChapter = (refStr, ctx = {}) => {
      const ref = chRef(refStr);
      const ch = ref === null || ref === '' ? null : chapterByRef(refStr);
      if (ref === '' || ref === null || !ch) {
        issue('warning', 'chapter-ref-unresolved', `chapter reference "${refStr}" matches no chapter; its state change is attached to the "legacy-unplaced" event`, ctx);
        return bucket('unplaced', () => ({ kind: 'unplaced', title: 'Unplaced legacy state', order: 999999, ch: null, when: '', base: 'legacy-unplaced', fixedSlug: 'legacy-unplaced', id: deterministicId('event', 'legacy/event', `${bid}:unplaced`) }));
      }
      const first = events.filter((x) => x.kind === 'prog' && x.ch === ch).sort((x, y) => x.order - y.order || compareIds(x.p.id, y.p.id))[0];
      if (first) return first;
      return bucket(`chapter:${ch.n}`, () => ({ kind: 'chapter', title: `Chapter ${ch.n} (legacy state)`, order: ch.n, ch, when: '', base: `legacy-chapter-${ch.n}`, fixedSlug: `legacy-chapter-${ch.n}`, id: deterministicId('event', 'legacy/event', `${bid}:chapter:${ch.c.id}`) }));
    };
    const eventBeforeStory = () => bucket('before', () => ({ kind: 'before', title: 'Before the story (legacy knowledge)', order: 0, ch: null, when: '', base: 'legacy-before-story', fixedSlug: 'legacy-before-story', id: deterministicId('event', 'legacy/event', `${bid}:before`) }));

    // state events
    const stateRows = mine('state_events').sort((x, y) => compareIds(x.id, y.id));
    for (const s of stateRows) {
      const refStr = str(s.row, 'chapter');
      const ev = eventForChapter(refStr, { table: 'state_events', id: s.id });
      ev.sources.push({ table: 'state_events', id: s.id });
      const slugL = str(s.row, 'slug');
      const kind = str(s.row, 'event');
      const value = str(s.row, 'value');
      const note = str(s.row, 'note');
      const rule = STATE_TYPES[kind];
      const drop = (code, why) => {
        issue('warning', code, `state event ${s.id} (${slugL} ${kind}${value ? ` ${value}` : ''}, chapter ${refStr}): ${why}; it is kept as a comment in the event body`, { table: 'state_events', id: s.id });
        ev.notes.push(`legacy state not applied: ${slugL} ${kind}${value ? ` ${value}` : ''} (chapter ${refStr})${note ? ` - ${oneLine(note)}` : ''}`);
      };
      if (!rule) {
        drop('state-unresolved', `unknown event word "${kind}"`);
        continue;
      }
      const en = findEntry(slugL);
      if (!en) {
        drop('state-unresolved', `"${slugL}" is not a codex entry`);
        continue;
      }
      if (rule.slug && !rule.slug.includes(en.type)) {
        drop('state-type-mismatch', `${slugL} is a ${en.type}, but ${kind} needs ${rule.slug.join(' or ')}`);
        continue;
      }
      const item = { slug: en.slug, event: kind };
      if (STATE_VALUED.has(kind)) {
        const ve = value === '' ? null : findEntry(value);
        if (!ve) {
          drop('state-unresolved', `"${value}" is not a codex entry`);
          continue;
        }
        if (!rule.value.includes(ve.type)) {
          drop('state-type-mismatch', `${value} is a ${ve.type}, but ${kind} needs ${rule.value.join(' or ')}`);
          continue;
        }
        item.value = ve.slug;
      }
      ev.state.push(item);
      if (note) ev.notes.push(`${slugL} ${kind}: ${oneLine(note)}`);
    }
    // knowledge facts
    const knowRows = mine('knowledge_facts').sort((x, y) => compareIds(x.id, y.id));
    const factKeys = new Set();
    for (const k of knowRows) {
      const learned = str(k.row, 'learned_in');
      const ev = learned === '' ? eventBeforeStory() : eventForChapter(learned, { table: 'knowledge_facts', id: k.id });
      ev.sources.push({ table: 'knowledge_facts', id: k.id });
      const who = findEntry(str(k.row, 'character_slug'));
      const knows = str(k.row, 'knows');
      const fact = slugify(str(k.row, 'fact')) || slugify(knows) || 'fact';
      if (!who || who.type !== 'character') {
        issue('warning', 'state-unresolved', `knowledge fact ${k.id}: "${str(k.row, 'character_slug')}" is not a character entry; it is kept as a comment in the event body`, { table: 'knowledge_facts', id: k.id });
        ev.notes.push(`legacy knowledge not applied: ${str(k.row, 'character_slug')} learns ${fact} - ${oneLine(knows)}`);
        continue;
      }
      ev.state.push({ slug: who.slug, event: learned === '' ? 'knows' : 'learns', value: fact });
      factKeys.add(`${who.slug}/${fact}`);
      ev.notes.push(`${who.slug} ${learned === '' ? 'knows' : 'learns'} ${fact}: ${oneLine(knows)}`);
    }
    // progression participants
    for (const ev of events.filter((x) => x.kind === 'prog')) {
      ev.chars = [];
      ev.locs = [];
      for (const s of str(ev.p.row, 'related_csv').split(',').map((x) => x.trim()).filter(Boolean)) {
        const en = findEntry(s);
        if (!en) {
          issue('warning', 'related-unresolved', `progression ${ev.p.id} names "${s}", which is not a codex entry; it is kept as a comment`, { table: 'progressions', id: ev.p.id });
          ev.notes.push(`legacy related not applied: ${s}`);
        } else if (en.type === 'location') ev.locs.push(en.slug);
        else ev.chars.push(en.slug);
      }
    }
    // event slugs (generated ones never fail: they are made unique with -2, -3)
    for (const ev of events) {
      const { slug } = claim(ev.fixedSlug ?? ev.base, `event:${ev.key}`);
      ev.slug = slug;
    }

    // -------- link handling --------
    const allIds = new Set([...chapters.map((c) => c.id), ...chapters.flatMap((c) => c.scenes.map((s) => s.id)), ...entries.map((e) => e.id), ...ledger.map((t) => t.id), ...events.map((e) => e.id)]);
    const prevSlugs = new Set([...entries.flatMap((e) => (e.prev ? [e.prev] : [])), ...ledger.flatMap((t) => (t.prev ? [t.prev] : []))]);
    const linkKnown = (t) => slugs.has(t) || prevSlugs.has(t) || allIds.has(t) || t.includes(':') || /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(t);

    /** Links of a non-scene document: unknown wiki links become their text, relative Markdown links become "text (target)". */
    const cleanBody = (text, ctx) => {
      if (!text) return text;
      let fence = null;
      return text
        .split('\n')
        .map((line) => {
          const m = FENCE_RE.exec(line);
          if (fence) {
            if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
            return line;
          }
          if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
            fence = { ch: m[1][0], len: m[1].length };
            return line;
          }
          const masked = line.replace(INLINE_CODE_RE, (s) => ' '.repeat(s.length));
          const edits = [];
          for (const w of masked.matchAll(WIKI_RE)) {
            const inner = w[1];
            const bar = inner.indexOf('|');
            const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
            const label = bar < 0 ? null : inner.slice(bar + 1);
            if (target === '' || linkKnown(target)) continue;
            const norm = slugify(target);
            if (norm && slugs.has(norm)) {
              edits.push([w.index, w.index + w[0].length, `[[${norm}|${label ?? target}]]`]);
              issue('info', 'link-normalised', `link [[${target}]] now points at "${norm}"`, { ...ctx });
            } else {
              edits.push([w.index, w.index + w[0].length, label ?? target]);
              issue('warning', 'unknown-link', `link [[${target}]] matches no entry, thread or event; it is kept as plain text`, { ...ctx });
            }
          }
          for (const w of masked.matchAll(MDLINK_RE)) {
            const dest = w[3].trim().replace(/^<|>$/g, '').split(/\s+/)[0];
            const external = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest) && !/^[A-Za-z]:[\\/]/.test(dest) && !/^file:/i.test(dest);
            if (external || dest.startsWith('#') || dest === '') continue;
            edits.push([w.index, w.index + w[0].length, `${w[2]} (${w[3].trim()})`]);
            issue('warning', 'link-flattened', `the file link (${dest}) points at a file the import does not create; it is kept as plain text`, { ...ctx });
          }
          let out = line;
          for (const [a, z, rep] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + rep + out.slice(z);
          return out;
        })
        .join('\n');
    };
    /** Warn about links in scene text; the text itself is never changed. */
    const checkSceneLinks = (body, ctx) => {
      const seen = new Set();
      let fence = null;
      for (const line of body.split('\n')) {
        const m = FENCE_RE.exec(line);
        if (fence) {
          if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
          continue;
        }
        if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
          fence = { ch: m[1][0], len: m[1].length };
          continue;
        }
        for (const w of line.replace(INLINE_CODE_RE, (s) => ' '.repeat(s.length)).matchAll(WIKI_RE)) {
          const target = w[1].split('|')[0].trim();
          if (target === '' || linkKnown(target) || seen.has(target)) continue;
          seen.add(target);
          issue('warning', 'unknown-link', `link [[${target}]] matches no entry, thread or event; the scene text is kept exactly as written`, { ...ctx });
        }
      }
    };

    // -------- write: book.md --------
    const r0 = b.r.row;
    const bookStatus = { planning: 'planning', drafting: 'drafting', revising: 'revising', published: 'complete', complete: 'complete' }[str(r0, 'status')] ?? 'planning';
    const profile = ['fiction', 'nonfiction', 'memoir', 'selfhelp'].includes(str(r0, 'profile')) ? str(r0, 'profile') : 'fiction';
    const genre = str(r0, 'genre').split(',').map((x) => x.trim()).filter(Boolean);
    const wt = numOr(r0.word_target, null);
    if (str(r0, 'series') !== '') issue('info', 'series-not-modelled', `book "${b.title}" names the series "${str(r0, 'series')}"; the legacy data has no series entity, so it is kept as x-legacy-series and no series folder is created`, { table: 'books', id: bid });
    const bookPath = addFile(b, 'book.md', `${frontMatter({
      schema: 'storyforge.book/v1', id: deterministicId('book', 'books', bid), slug: b.slug, title: b.title, profile, status: bookStatus,
      genre: genre.length ? genre : undefined, word_target: wt !== null && Number.isInteger(wt) && wt >= 0 ? wt : undefined, language: 'en',
      'x-legacy-id': bid, 'x-legacy-folder': str(r0, 'folder') || undefined, 'x-legacy-series': str(r0, 'series') || undefined, 'x-legacy-num': str(r0, 'num') || undefined,
      'x-legacy-status': str(r0, 'status') || undefined, 'x-legacy-dot': str(r0, 'dot') || undefined,
    })}${cleanBody(str(r0, 'logline'), { table: 'books', id: bid, path: `${root}book.md` })}${str(r0, 'logline') ? '\n' : ''}`, 'book', [{ table: 'books', id: bid }]);
    setDisposition('books', bid, 'converted', bookPath);

    // -------- write: acts --------
    for (const [i, a] of acts.entries()) {
      const p = addFile(b, `manuscript/${actFolder.get(i + 1)}/act.md`, frontMatter({
        schema: 'storyforge.act/v1', id: deterministicId('act', 'acts', a.id), act: i + 1, title: str(a.row, 'title') || `Act ${i + 1}`, 'x-legacy-subtitle': str(a.row, 'subtitle') || undefined,
      }), 'act', [{ table: 'acts', id: a.id }]);
      setDisposition('acts', a.id, 'converted', p);
    }

    // -------- chapter cast --------
    const castRows = mine('chapter_cast').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id));
    const castOf = new Map();
    for (const cr of castRows) {
      const ch = chapterByFile.get(str(cr.row, 'chapter_file'));
      if (!ch) {
        setDisposition('chapter_cast', cr.id, 'skipped', null, `chapter file "${str(cr.row, 'chapter_file')}" matches no chapter`);
        issue('warning', 'orphan-row', `chapter_cast row ${cr.id} names the chapter file "${str(cr.row, 'chapter_file')}", which matches no chapter`, { table: 'chapter_cast', id: cr.id });
        continue;
      }
      if (!castOf.has(ch)) castOf.set(ch, []);
      castOf.get(ch).push(cr);
    }

    // -------- write: chapters and scenes --------
    for (const ch of chapters) {
      const cdir = `${ch.dir}`;
      const cast = castOf.get(ch) ?? [];
      const notes = [];
      let pov = null;
      const characters = [];
      const mentioned = [];
      for (const cr of cast) {
        const en = findEntry(str(cr.row, 'slug'));
        const role = str(cr.row, 'role');
        if (!en) {
          issue('warning', 'cast-unresolved', `chapter ${ch.c.id}: cast member "${str(cr.row, 'slug')}" is not a codex entry; it is listed in chapter.md only`, { table: 'chapter_cast', id: cr.id });
          notes.push(`legacy cast not applied: ${str(cr.row, 'slug')} (${role})`);
          continue;
        }
        if (role === 'pov' && !pov) pov = en.slug;
        if (role === 'mentioned') mentioned.push(en.slug);
        else if (!characters.includes(en.slug)) characters.push(en.slug);
      }
      if (!pov && str(ch.c.row, 'pov') !== '') {
        const en = findEntry(str(ch.c.row, 'pov'));
        if (en) {
          pov = en.slug;
          if (!characters.includes(en.slug)) characters.push(en.slug);
        } else notes.push(`legacy chapter pov "${str(ch.c.row, 'pov')}" matches no codex entry`);
      }
      const baseStatus = SCENE_STATUS[str(ch.c.row, 'status')] ?? 'drafting';
      let prevMain = null;
      const sceneSources = [{ table: 'chapters', id: ch.c.id }, ...cast.map((x) => ({ table: 'chapter_cast', id: x.id }))];
      ch.scenes.forEach((sc, i) => {
        const cached = sc.cached ? sc.cached.row : null;
        const label = cached ? str(cached, 'label') : '';
        let status = LABEL_STATUS[label] ?? baseStatus;
        let variantOf;
        if (label === 'Alt version') {
          if (prevMain) variantOf = prevMain;
          else issue('info', 'scene-label-not-applied', `scene ${sc.ordinal} of chapter ${ch.c.id} is labelled "Alt version" but has no scene before it to be a variant of; the label is kept as x-legacy-label`, { table: 'chapters', id: ch.c.id });
        }
        if (label === 'Note') issue('info', 'scene-label-not-applied', `scene ${sc.ordinal} of chapter ${ch.c.id} is labelled "Note"; its text is kept as a scene and the label as x-legacy-label`, { table: 'chapters', id: ch.c.id });
        if (!variantOf) prevMain = sc.id;
        else status = baseStatus;
        sc.variantOf = variantOf;
        const fm = {
          schema: 'storyforge.scene/v1', id: sc.id, title: sc.title, act: ch.act, chapter: ch.n, sequence: sc.sequence, status,
          pov: pov ?? undefined, characters: characters.length ? characters : undefined, summary: cached && str(cached, 'summary') !== '' ? oneLine(str(cached, 'summary')) : undefined,
          variant_of: variantOf, 'x-legacy-label': label && (label === 'Note' || (label === 'Alt version' && !variantOf)) ? label : undefined,
          'x-legacy-cast-review': cast.length ? true : undefined, 'x-legacy-mentioned': mentioned.length ? mentioned : undefined,
        };
        const slug = slugify(sc.title.replace(/—/g, ' ')) || 'scene';
        const path = addFile(b, `${cdir}/${pad(sc.sequence, 4)}-${slug}.md`, Buffer.concat([Buffer.from(frontMatter(fm), 'utf8'), Buffer.from(sc.body, 'utf8')]), 'scene', [...sceneSources, ...(sc.cached ? [{ table: 'scenes', id: sc.cached.id }] : [])]);
        sc.path = path;
        sc.glueAfter = sc.glue;
        checkSceneLinks(sc.body, { table: 'chapters', id: ch.c.id, path });
        if (i === 0 && cast.length) for (const cr of cast) setDisposition('chapter_cast', cr.id, 'converted', path);
      });
      const refNum = chRef(ch.num);
      const chapterLabel = refNum === 'prologue' ? 'Prologue' : refNum === 'epilogue' ? 'Epilogue' : refNum ? `Chapter ${refNum}` : ch.num || undefined;
      const chapterPath = addFile(b, `${cdir}/chapter.md`, `${frontMatter({
        schema: 'storyforge.chapter/v1', id: ch.id, chapter: ch.n, label: chapterLabel, title: ch.title, status: str(ch.c.row, 'status') || undefined,
        summary: str(ch.c.row, 'summary') ? oneLine(str(ch.c.row, 'summary')) : undefined, 'x-legacy-num': ch.num, 'x-legacy-file': ch.file || undefined,
        'x-legacy-sort-order': numOr(ch.c.row.sort_order, undefined),
      })}${notes.length ? `${notes.map((x) => `<!-- ${x} -->`).join('\n')}\n` : ''}`, 'chapter', [{ table: 'chapters', id: ch.c.id }]);
      ch.chapterPath = chapterPath;
      setDisposition('chapters', ch.c.id, 'converted', chapterPath);
      if (cast.length && ch.scenes.length === 0) for (const cr of cast) setDisposition('chapter_cast', cr.id, 'converted', chapterPath);
      // the scenes cache rows of this chapter
      for (const cr of ch.cacheAll) {
        const used = ch.cache.includes(cr) && (str(cr.row, 'label') !== '' || str(cr.row, 'summary') !== '');
        if (used) setDisposition('scenes', cr.id, 'merged', ch.scenes[ch.cache.indexOf(cr)]?.path, 'label and summary applied to the scene file');
        else setDisposition('scenes', cr.id, 'derived', null, ch.cache.includes(cr) ? 'cache row without label or summary; scenes are rebuilt from the text' : 'cache does not match the chapter text; scenes are rebuilt from the text');
      }
    }
    for (const r of readmes) {
      setDisposition('chapters', r.id, 'kept-as-data', `${root}legacy/tables/chapters.jsonl`, 'a README file, not a chapter');
      keepRow(b, 'chapters', r);
      issue('info', 'readme-chapter', `chapters row ${r.id} (${str(r.row, 'file')}) is a README file, not a chapter; it is kept as data`, { table: 'chapters', id: r.id });
    }

    // -------- write: entries --------
    const fieldsOf = new Map();
    const sectionsOf = new Map();
    const relsOf = new Map();
    const push = (map, k, v) => map.set(k, [...(map.get(k) ?? []), v]);
    for (const f of R('entry_fields').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id))) push(fieldsOf, str(f.row, 'entry_id'), f);
    for (const f of R('entry_sections').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id))) push(sectionsOf, str(f.row, 'entry_id'), f);
    for (const f of R('entry_relations').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id))) push(relsOf, str(f.row, 'entry_id'), f);
    for (const en of entries) {
      const e = en.e;
      const path = `${root}codex/${en.folder}/${en.slug}.md`;
      const ctx = { table: 'entries', id: e.id, path };
      const fields = {};
      const children = [];
      for (const f of fieldsOf.get(e.id) ?? []) {
        let label = str(f.row, 'label').trim() || 'Field';
        for (let k = 2; Object.hasOwn(fields, label); k++) label = `${str(f.row, 'label').trim() || 'Field'} (${k})`;
        fields[label] = cleanBody(str(f.row, 'value'), ctx);
        children.push({ table: 'entry_fields', id: f.id });
      }
      const related = [];
      const unresolved = [];
      for (const r of relsOf.get(e.id) ?? []) {
        children.push({ table: 'entry_relations', id: r.id });
        const target = str(r.row, 'target_slug');
        const found = findEntry(target) ?? threadByLegacy.get(target) ?? null;
        const toSlug = found ? found.slug : null;
        if (toSlug && !related.some((x) => x.to === toSlug)) related.push({ to: toSlug });
        else if (!toSlug) {
          unresolved.push(target);
          issue('warning', 'related-unresolved', `entry ${e.id} lists "${target}" as related, but no entry has that slug; it is kept as a comment`, ctx);
        }
      }
      const sections = [];
      for (const s of sectionsOf.get(e.id) ?? []) {
        children.push({ table: 'entry_sections', id: s.id });
        sections.push(`## ${str(s.row, 'heading')}\n${cleanBody(str(s.row, 'body'), ctx).replace(/^\n+|\n+$/g, '')}`.trimEnd());
      }
      const firstApp = chapterByRef(str(e.row, 'first_app'));
      const status = ['seed', 'sketch', 'canon'].includes(str(e.row, 'status')) ? str(e.row, 'status') : 'seed';
      if (status !== str(e.row, 'status')) issue('warning', 'unknown-status', `entry ${e.id} has the unknown status "${str(e.row, 'status')}"; it becomes "seed"`, ctx);
      let body = sections.join('\n\n');
      if (unresolved.length) body += `${body ? '\n\n' : ''}<!-- legacy related not applied: ${unresolved.join(', ')} -->`;
      const text = `${frontMatter({
        schema: 'storyforge.entry/v1', id: en.id, slug: en.slug, previous_slugs: en.prev ? [en.prev] : undefined, type: en.type, name: str(e.row, 'name') || en.slug, status,
        first_appearance: firstApp ? firstSceneId(firstApp) ?? undefined : undefined, fields: Object.keys(fields).length ? fields : undefined, related: related.length ? related : undefined,
        'x-legacy-db': en.db,
      })}${body}${body ? '\n' : ''}`;
      addFile(b, `codex/${en.folder}/${en.slug}.md`, text, 'entry', [{ table: 'entries', id: e.id }, ...children]);
      setDisposition('entries', e.id, 'converted', path);
      for (const c of children) setDisposition(c.table, c.id, 'merged', path);
    }

    // -------- write: threads --------
    const sceneRef = (refStr) => {
      const ch = chapterByRef(refStr);
      return { ch, scene: ch ? firstSceneId(ch) : null };
    };
    for (const t of ledger) {
      const l = t.l;
      const path = `${root}planning/threads/${t.slug}.md`;
      const ctx = { table: 'story_ledger', id: l.id, path };
      const kind = str(l.row, 'kind') === 'question' ? 'question' : 'promise';
      const legacyStatus = str(l.row, 'status');
      let status;
      if (kind === 'question') status = { open: 'open', resolved: 'paid', dropped: 'dropped', abandoned: 'dropped' }[legacyStatus];
      else status = { planned: 'planned', planted: 'planted', 'paid-off': 'paid', dropped: 'dropped', abandoned: 'dropped' }[legacyStatus];
      if (!status) {
        status = kind === 'question' ? (str(l.row, 'payoff_in') ? 'paid' : 'open') : str(l.row, 'payoff_in') ? 'paid' : str(l.row, 'planted_in') ? 'planted' : 'planned';
        issue('warning', 'unknown-status', `ledger item ${l.id} has the status "${legacyStatus}"; it becomes "${status}"`, ctx);
      }
      const notes = [];
      const resolve = (field) => {
        const refStr = str(l.row, field);
        if (refStr === '') return [];
        const { ch, scene } = sceneRef(refStr);
        if (!scene) {
          issue('warning', 'chapter-ref-unresolved', `ledger item ${l.id}: ${field} "${refStr}" matches no chapter with scenes; it is kept in the thread text`, ctx);
          notes.push(`legacy ${field}: ${refStr} (no matching chapter)`);
          return [];
        }
        if (ch.scenes.length > 1) notes.push(`${field}: chapter ${refStr} is a whole chapter in the legacy data; it is linked to the chapter's first scene`);
        return [scene];
      };
      const setup = resolve('planted_in');
      const payoff = resolve('payoff_in');
      const chars = [];
      for (const cs of str(l.row, 'characters_csv').split(',').map((x) => x.trim()).filter(Boolean)) {
        const en = findEntry(cs);
        if (en && !chars.includes(en.slug)) chars.push(en.slug);
        else if (!en) {
          issue('warning', 'cast-unresolved', `ledger item ${l.id} names the character "${cs}", who is not a codex entry; it is kept in the thread text`, ctx);
          notes.push(`legacy character not applied: ${cs}`);
        }
      }
      const text = cleanBody(str(l.row, 'notes'), ctx);
      addFile(b, `planning/threads/${t.slug}.md`, `${frontMatter({
        schema: 'storyforge.thread/v1', id: t.id, slug: t.slug, previous_slugs: t.prev ? [t.prev] : undefined, title: str(l.row, 'title') || t.slug, kind, status, setup, develop: [], payoff, characters: chars,
        'x-legacy-status': legacyStatus || undefined, 'x-legacy-planted-in': str(l.row, 'planted_in') || undefined, 'x-legacy-payoff-in': str(l.row, 'payoff_in') || undefined,
      })}${[text, ...notes.map((x) => `<!-- ${x} -->`)].filter(Boolean).join('\n\n')}${text || notes.length ? '\n' : ''}`, 'thread', [{ table: 'story_ledger', id: l.id }]);
      setDisposition('story_ledger', l.id, 'converted', path);
    }

    // -------- write: events --------
    for (const ev of events) {
      const path = `${root}planning/timeline/${ev.slug}.md`;
      const ctx = { table: ev.kind === 'prog' ? 'progressions' : 'state_events', id: ev.p?.id, path };
      const body = [];
      if (ev.what) body.push(cleanBody(ev.what, ctx));
      if (ev.notes.length) body.push(ev.notes.map((x) => (/not applied/.test(x) ? `<!-- ${x} -->` : `- ${x}`)).join('\n'));
      const scenes = ev.ch ? [firstSceneId(ev.ch)].filter(Boolean) : [];
      addFile(b, `planning/timeline/${ev.slug}.md`, `${frontMatter({
        schema: 'storyforge.event/v1', id: ev.id, slug: ev.slug, title: ev.title, order: ev.order, when: ev.when || undefined, scenes, characters: ev.chars ?? [], locations: ev.locs ?? [],
        state: ev.state.length ? ev.state : undefined, 'x-legacy-type': ev.type || undefined, 'x-legacy-chapter': ev.chapterLabel || undefined,
      })}${body.join('\n\n')}${body.length ? '\n' : ''}`, 'event', ev.sources);
      for (const s of ev.sources) setDisposition(s.table, s.id, 'converted', path);
    }

    // -------- write: sources --------
    const usedCite = new Set();
    for (const s of mine('sources').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id))) {
      const key = str(s.row, 'cite_key');
      const base = slugify(key) || 'source';
      let cite = base;
      for (let k = 2; usedCite.has(cite); k++) cite = `${base.slice(0, 56)}-${k}`;
      usedCite.add(cite);
      if (cite !== key) issue('info', 'cite-key-normalised', `source ${s.id}: cite key "${key}" becomes "${cite}"`, { table: 'sources', id: s.id });
      const path = `${root}research/sources/${cite}.md`;
      const note = cleanBody(str(s.row, 'note'), { table: 'sources', id: s.id, path });
      addFile(b, `research/sources/${cite}.md`, `${frontMatter({
        schema: 'storyforge.source/v1', id: deterministicId('note', 'sources', s.id), cite_key: cite, title: str(s.row, 'title') || cite, type: str(s.row, 'type') || undefined,
        author: str(s.row, 'author') || undefined, year: str(s.row, 'year') || undefined, publisher: str(s.row, 'publisher') || undefined, url: str(s.row, 'url') || undefined,
        accessed: str(s.row, 'accessed') || undefined, locator: str(s.row, 'locator') || undefined, 'x-legacy-cite-key': cite !== key ? key : undefined,
      })}${note}${note ? '\n' : ''}`, 'source', [{ table: 'sources', id: s.id }]);
      setDisposition('sources', s.id, 'converted', path);
    }

    // -------- write: planning documents --------
    const docIds = new Set();
    const doc = (table, row, relPath, title, bodyText, extra = {}) => {
      const path = `${root}${relPath}`;
      const text = `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', table, row.id), title, ...extra })}${cleanBody(bodyText, { table, id: row.id, path })}`;
      const final = addFile(b, relPath, text.endsWith('\n') || bodyText === '' ? text : `${text}\n`, 'doc', [{ table, id: row.id }]);
      docIds.add(final);
      setDisposition(table, row.id, 'converted', final);
      return final;
    };
    for (const r of mine('note_pages')) doc('note_pages', r, `planning/notes/${slugify(str(r.row, 'slug')) || `note-${r.id}`}.md`, str(r.row, 'title') || str(r.row, 'slug') || 'Note', str(r.row, 'body'));
    for (const r of mine('meta_pages')) doc('meta_pages', r, `planning/meta/${slugify(str(r.row, 'slug')) || `meta-${r.id}`}.md`, str(r.row, 'title') || str(r.row, 'slug') || 'Page', str(r.row, 'body'));
    for (const r of mine('workspace_docs')) {
      const segs = str(r.row, 'path').split('/').map((x) => x.replace(/[^0-9a-z-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '')).filter(Boolean);
      doc('workspace_docs', r, `planning/${(segs.length ? segs : [`doc-${r.id}`]).join('/')}.md`, str(r.row, 'title') || str(r.row, 'path') || 'Document', str(r.row, 'body'), { locked: numOr(r.row.locked, 0) ? true : false });
    }

    // continuity exemptions
    const ex = mine('continuity_exemptions').sort((x, y) => compareIds(x.id, y.id));
    if (ex.length) {
      const lines = ex.map((x) => `- **${str(x.row, 'code')}**${str(x.row, 'slug') ? ` ${str(x.row, 'slug')}` : ''}${str(x.row, 'chapter') ? ` (chapter ${str(x.row, 'chapter')})` : ''}: ${oneLine(str(x.row, 'reason'))}`);
      const body = `These dismissals came from the legacy continuity checker. The v2 engine uses different fingerprints, so none of them carries over automatically; use them as a list of what to re-check.\n\n${lines.join('\n')}\n`;
      const path = addFile(b, 'planning/legacy/continuity-exemptions.md', `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', 'continuity_exemptions', bid), title: 'Legacy continuity exemptions' })}${cleanBody(body, { table: 'continuity_exemptions', path: `${root}planning/legacy/continuity-exemptions.md` })}`, 'doc', ex.map((x) => ({ table: 'continuity_exemptions', id: x.id })));
      for (const x of ex) setDisposition('continuity_exemptions', x.id, 'converted', path);
    }

    // tasks
    const steps = new Map();
    for (const s of R('task_steps').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id))) push(steps, str(s.row, 'task_id'), s);
    const usedTask = new Set();
    for (const t of mine('tasks').sort((x, y) => compareIds(x.id, y.id))) {
      const base = slugify(str(t.row, 'title')) || `task-${t.id}`;
      let slug = base;
      for (let k = 2; usedTask.has(slug); k++) slug = `${base.slice(0, 56)}-${k}`;
      usedTask.add(slug);
      const st = steps.get(t.id) ?? [];
      const parts = [str(t.row, 'body').trim()];
      if (st.length) parts.push(`## Steps\n${st.map((s) => `- [${numOr(s.row.done, 0) ? 'x' : ' '}] ${oneLine(str(s.row, 'text'))}`).join('\n')}`);
      if (str(t.row, 'result').trim()) parts.push(`## Result\n${str(t.row, 'result').trim()}`);
      const relPath = `planning/tasks/${slug}.md`;
      const path = `${root}${relPath}`;
      const body = cleanBody(parts.filter(Boolean).join('\n\n'), { table: 'tasks', id: t.id, path });
      const final = addFile(b, relPath, `${frontMatter({
        schema: 'storyforge.doc/v1', id: deterministicId('note', 'tasks', t.id), title: str(t.row, 'title') || slug, 'x-status': str(t.row, 'status') || undefined, 'x-priority': str(t.row, 'priority') || undefined,
        'x-due': str(t.row, 'due') || undefined, 'x-for-claude': numOr(t.row.for_claude, 0) ? true : undefined, 'x-target': str(t.row, 'target_slug') ? `${str(t.row, 'target_db')}/${str(t.row, 'target_slug')}` : undefined,
      })}${body}${body ? '\n' : ''}`, 'doc', [{ table: 'tasks', id: t.id }, ...st.map((s) => ({ table: 'task_steps', id: s.id }))]);
      setDisposition('tasks', t.id, 'converted', final);
      for (const s of st) setDisposition('task_steps', s.id, 'merged', final);
    }

    // writing log
    const wl = mine('writing_log').sort((x, y) => byCodePoint(str(x.row, 'log_date'), str(y.row, 'log_date')) || compareIds(x.id, y.id));
    if (wl.length) {
      const days = new Map();
      for (const w of wl) {
        const d = str(w.row, 'log_date').slice(0, 10);
        const day = days.get(d) ?? { added: 0, removed: 0, minutes: 0, sessions: 0 };
        const words = numOr(w.row.words_added, 0);
        if (words >= 0) day.added += words;
        else day.removed += -words;
        day.minutes += numOr(w.row.minutes, 0);
        day.sessions += 1;
        days.set(d, day);
      }
      const rows = [...days.entries()].sort((x, y) => byCodePoint(x[0], y[0])).map(([d, v]) => `| ${d} | ${v.added} | ${v.removed} | ${v.minutes} | ${v.sessions} |`);
      const body = `| Date | Words added | Words removed | Minutes | Sessions |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
      const path = addFile(b, 'activity/writing-log.md', `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', 'writing_log', bid), title: 'Writing log' })}${body}`, 'log', wl.map((w) => ({ table: 'writing_log', id: w.id })));
      for (const w of wl) setDisposition('writing_log', w.id, 'converted', path);
      for (const w of wl) keepRow(b, 'writing_log', w);
    }

    // chapter notes -> comments
    const cn = mine('chapter_notes').sort((x, y) => compareIds(x.id, y.id));
    const cnByChapter = new Map();
    for (const c of cn) {
      const ch = chapterByFile.get(str(c.row, 'chapter_file')) ?? null;
      const k = ch ? ch.cslug : 'unplaced';
      if (!ch) issue('warning', 'orphan-row', `comment ${c.id} names the chapter file "${str(c.row, 'chapter_file')}", which matches no chapter; it goes to planning/legacy/comments/unplaced.md`, { table: 'chapter_notes', id: c.id });
      if (!cnByChapter.has(k)) cnByChapter.set(k, { ch, list: [] });
      cnByChapter.get(k).list.push(c);
    }
    for (const [k, g] of [...cnByChapter.entries()].sort((x, y) => byCodePoint(x[0], y[0]))) {
      const blocks = g.list.map((c) => {
        const q = str(c.row, 'quote');
        const who = userName(c.row.user_id);
        const head = `## Comment ${c.id} (${str(c.row, 'status') || 'open'})${who ? ` by ${who}` : ''}${str(c.row, 'created_at') ? `, ${str(c.row, 'created_at')}` : ''}`;
        return [head, q ? q.split('\n').map((l) => `> ${l}`).join('\n') : '', str(c.row, 'note').trim()].filter(Boolean).join('\n\n');
      });
      const title = g.ch ? `Comments on ${g.ch.title || `chapter ${g.ch.num}`}` : 'Comments on chapters that could not be matched';
      const relPath = `planning/legacy/comments/${k}.md`;
      const path = `${root}${relPath}`;
      const final = addFile(b, relPath, `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', 'chapter_notes', `${bid}:${k}`), title })}${cleanBody(blocks.join('\n\n'), { table: 'chapter_notes', path })}\n`, 'doc', g.list.map((c) => ({ table: 'chapter_notes', id: c.id })));
      for (const c of g.list) setDisposition('chapter_notes', c.id, 'converted', final);
    }

    // board
    const cards = mine('canvas_cards').sort((x, y) => compareIds(x.id, y.id));
    const clinks = mine('canvas_links').sort((x, y) => compareIds(x.id, y.id));
    if (cards.length || clinks.length) {
      const cardLines = cards.map((c) => `- **Card ${c.id}** at (${numOr(c.row.x, 0)}, ${numOr(c.row.y, 0)}) ${str(c.row, 'color')}: ${oneLine(str(c.row, 'text')) || '(empty)'}${str(c.row, 'ref_type') ? ` - refers to ${str(c.row, 'ref_type')} ${str(c.row, 'ref_id')}` : ''}`);
      const linkLines = clinks.map((c) => `- Card ${str(c.row, 'from_id')} to card ${str(c.row, 'to_id')}`);
      const body = `${cards.length ? `## Cards\n${cardLines.join('\n')}\n` : ''}${clinks.length ? `${cards.length ? '\n' : ''}## Links\n${linkLines.join('\n')}\n` : ''}`;
      const path = addFile(b, 'planning/board.md', `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', 'canvas_cards', bid), title: 'Plot board' })}${cleanBody(body, { table: 'canvas_cards', path: `${root}planning/board.md` })}`, 'doc', [...cards.map((c) => ({ table: 'canvas_cards', id: c.id })), ...clinks.map((c) => ({ table: 'canvas_links', id: c.id }))]);
      for (const c of cards) setDisposition('canvas_cards', c.id, 'converted', path);
      for (const c of clinks) setDisposition('canvas_links', c.id, 'converted', path);
    }

    // mood board
    const vis = mine('vision_items').sort((x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id));
    if (vis.length) {
      const lines = vis.map((v) => {
        const url = str(v.row, 'image_url').trim();
        const cap = oneLine(str(v.row, 'caption')).replace(/[[\]]/g, '') || 'image';
        return /^https?:\/\/\S+$/.test(url) && !/[()]/.test(url) ? `- [${cap}](${url})` : `- ${cap}${url ? ` (${url.replace(/[()]/g, ' ')})` : ''}`;
      });
      const path = addFile(b, 'research/vision.md', `${frontMatter({ schema: 'storyforge.research/v1', id: deterministicId('note', 'vision_items', bid), title: 'Mood board', canon: false })}${lines.join('\n')}\n`, 'research', vis.map((v) => ({ table: 'vision_items', id: v.id })));
      for (const v of vis) setDisposition('vision_items', v.id, 'converted', path);
    }

    // captures (global captures with no book go to the first selected book)
    const caps = R('captures').filter((c) => (bookOfRow('captures', c.row) ?? (firstBook ? firstBook.legacy_id : null)) === bid).sort((x, y) => compareIds(x.id, y.id));
    if (caps.length) {
      const lines = caps.map((c) => `- [${str(c.row, 'status') || 'inbox'}] ${str(c.row, 'text').trim().replace(/\n/g, '\n  ')}${str(c.row, 'created_at') ? ` (${str(c.row, 'created_at').slice(0, 10)})` : ''}`);
      const path = addFile(b, 'planning/inbox.md', `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', 'captures', bid), title: 'Inbox' })}${cleanBody(lines.join('\n'), { table: 'captures', path: `${root}planning/inbox.md` })}\n`, 'doc', caps.map((c) => ({ table: 'captures', id: c.id })));
      for (const c of caps) setDisposition('captures', c.id, 'converted', path);
    }

    // dictionary
    const dict = mine('dictionary_terms').sort((x, y) => byCodePoint(str(x.row, 'term').toLowerCase(), str(y.row, 'term').toLowerCase()) || compareIds(x.id, y.id));
    if (dict.length) {
      const lines = dict.map((d) => `- ${str(d.row, 'term')}${str(d.row, 'source') ? ` (${str(d.row, 'source')})` : ''}`);
      const path = addFile(b, 'planning/dictionary.md', `${frontMatter({ schema: 'storyforge.doc/v1', id: deterministicId('note', 'dictionary_terms', bid), title: 'Dictionary' })}Words the legacy spell-checker was told to accept.\n\n${lines.join('\n')}\n`, 'doc', dict.map((d) => ({ table: 'dictionary_terms', id: d.id })));
      for (const d of dict) setDisposition('dictionary_terms', d.id, 'converted', path);
    }

    // -------- history --------
    const stamp = (row, id) => {
      const digits = str(row, 'created_at').replace(/\D/g, '');
      return digits.length >= 14 ? `${digits.slice(0, 8)}-${digits.slice(8, 14)}` : `unknown-${id}`;
    };
    const history = (table, kindDir, folder, row, id, body, who) => {
      const kind = str(row, 'kind');
      const suffix = kind && kind !== 'save' ? `-${slugify(kind)}` : '';
      const fm = frontMatter({ legacy_table: table, legacy_id: /^\d+$/.test(id) ? Number(id) : id, saved_at: str(row, 'created_at'), saved_by_name: who });
      const path = addFile(b, `legacy/history/${kindDir}/${folder}/${stamp(row, id)}${suffix}.md`, Buffer.concat([Buffer.from(fm, 'utf8'), Buffer.from(body, 'utf8')]), 'history', [{ table, id }]);
      setDisposition(table, id, 'history', path);
    };
    for (const r of R('chapter_revisions')) {
      const owner = bookOfRow('chapter_revisions', r.row);
      if (owner !== bid) continue;
      const ch = chapterByDbId.get(str(r.row, 'chapter_id')) ?? chapterByFile.get(str(r.row, 'chapter_file'));
      history('chapter_revisions', 'chapters', ch ? ch.cslug : slugify(str(r.row, 'chapter_file')) || `chapter-${str(r.row, 'chapter_id')}`, r.row, r.id, str(r.row, 'body'), userName(r.row.saved_by));
    }
    for (const r of mine('entry_revisions')) {
      const en = entries.find((x) => x.db === str(r.row, 'db_key') && x.legacySlug === str(r.row, 'slug'));
      history('entry_revisions', 'entries', en ? en.slug : slugify(str(r.row, 'slug')) || `entry-${r.id}`, r.row, r.id, str(r.row, 'body'), userName(r.row.saved_by));
    }
    for (const r of mine('workspace_revisions')) {
      history('workspace_revisions', 'workspace', str(r.row, 'path').split('/').map((x) => slugify(x)).filter(Boolean).join('-') || `doc-${r.id}`, r.row, r.id, str(r.row, 'body'), userName(r.row.saved_by));
    }
  }

  // ---- rows that belong to no selected book, unknown tables, server-only, derived ----------------------------------------------------
  for (const [name, t] of dump.tables) {
    if (t.skipped) continue;
    const unknown = !KNOWN_TABLES.has(name) && !name.startsWith('oauth_');
    if (unknown) issue('info', 'unknown-table', `the table "${name}" is not one the importer knows (the legacy schema may have changed); its rows are kept as data under legacy/tables/`, { table: name });
    for (const r of rowsOf.get(name)) {
      if (dispositions.has(dkey(name, r.id))) continue;
      if (isServerOnly(name)) {
        setDisposition(name, r.id, 'server-only', null, 'accounts, members, activity, locks and tokens are not imported (M07)');
        continue;
      }
      const owner = bookOfRow(name, r.row);
      if (unknown) {
        const b = (owner && selected.find((x) => x.legacy_id === owner)) ?? firstBook;
        if (!b) setDisposition(name, r.id, 'skipped', null, 'no book was selected');
        else {
          keepRow(b, name, r);
          setDisposition(name, r.id, 'kept-as-data', `${b.slug}/legacy/tables/${name}.jsonl`);
        }
        continue;
      }
      if (owner && !selectedIds.has(owner)) {
        setDisposition(name, r.id, 'skipped', null, 'its book was not selected');
        continue;
      }
      if (name === 'captures' && !owner) {
        if (!firstBook) setDisposition(name, r.id, 'skipped', null, 'no book was selected');
        continue;
      }
      if (DERIVED_TABLES.has(name)) {
        setDisposition(name, r.id, 'derived', null, 'a cache that v2 rebuilds from the files');
        continue;
      }
      if (owner === null && ['entry_fields', 'entry_sections', 'entry_relations', 'task_steps'].includes(name)) {
        setDisposition(name, r.id, 'skipped', null, 'orphan row: its parent row does not exist');
        issue('warning', 'orphan-row', `${name} row ${r.id} belongs to a row that does not exist`, { table: name, id: r.id });
        continue;
      }
      if (name === 'chapter_revisions' && !owner) {
        const ch = [...builders.values()].flatMap((x) => x.chapters).find((c) => c.file === str(r.row, 'chapter_file'));
        if (!ch) {
          setDisposition(name, r.id, 'skipped', null, 'its chapter does not exist');
          issue('warning', 'orphan-row', `chapter_revisions row ${r.id} belongs to a chapter that does not exist`, { table: name, id: r.id });
        }
        continue;
      }
      if (name === 'books' || owner === null) {
        setDisposition(name, r.id, 'skipped', null, name === 'books' ? 'this book was not selected' : 'not tied to any book');
        continue;
      }
      setDisposition(name, r.id, 'skipped', null, 'no importer rule');
      issue('warning', 'unhandled-row', `${name} row ${r.id} had no importer rule`, { table: name, id: r.id });
    }
  }

  // verbatim copies: kept-as-data tables, writing_log, rows with bytes that are not UTF-8
  const invalid = new Map();
  for (const [name, t] of dump.tables) {
    if (t.skipped || isServerOnly(name)) continue;
    for (const r of rowsOf.get(name)) {
      const bad = Object.entries(r.row).filter(([, v]) => isB64(v) && lossy(v)).map(([k]) => k);
      if (!bad.length) continue;
      issue('warning', 'invalid-utf8', `${name} row ${r.id}: ${bad.join(', ')} hold bytes that are not valid UTF-8; the text shows U+FFFD and the exact bytes are kept in legacy/tables/${name}-invalid-utf8.jsonl`, { table: name, id: r.id });
      const owner = bookOfRow(name, r.row);
      const b = (owner && selected.find((x) => x.legacy_id === owner)) ?? firstBook;
      if (!b) continue;
      const k = `${b.legacy_id}\u0000${name}-invalid-utf8`;
      if (!invalid.has(k)) invalid.set(k, { book: b, table: name, name: `${name}-invalid-utf8`, recs: [] });
      invalid.get(k).recs.push(r);
    }
  }
  const writeKept = (g, fileName) => {
    const text = `${g.recs.map((r) => r.raw).join('\n')}\n`;
    addFile(g.book, `legacy/tables/${fileName}.jsonl`, text, 'data', g.recs.map((r) => ({ table: g.table, id: r.id })));
  };
  for (const g of kept.values()) writeKept(g, g.table);
  for (const g of invalid.values()) writeKept(g, g.name);

  // safety net: every dumped row has exactly one disposition
  for (const [name, t] of dump.tables) {
    if (t.skipped) continue;
    for (const r of rowsOf.get(name)) {
      if (dispositions.has(dkey(name, r.id))) continue;
      setDisposition(name, r.id, 'skipped', null, 'no importer rule');
      issue('warning', 'unhandled-row', `${name} row ${r.id} had no importer rule`, { table: name, id: r.id });
    }
  }

  // ---- assemble the plan ---------------------------------------------------------------------------------------------------------
  const books = selected.map((b) => ({
    legacy_id: b.legacy_id, slug: b.slug, title: b.title, root: `${b.slug}/`,
    files: [...files.get(b.legacy_id).values()].sort((x, y) => byCodePoint(x.path, y.path)),
  }));
  const tableNames = [...dump.tables.keys()];
  const dispositionList = [];
  for (const name of tableNames) for (const r of rowsOf.get(name)) dispositionList.push(dispositions.get(dkey(name, r.id)));
  const summaryTables = {};
  let total = 0;
  let covered = 0;
  for (const name of tableNames) {
    const t = dump.tables.get(name);
    const by = {};
    for (const r of rowsOf.get(name)) {
      const d = dispositions.get(dkey(name, r.id));
      total += 1;
      if (d) covered += 1;
      by[d.disposition] = (by[d.disposition] ?? 0) + 1;
    }
    summaryTables[name] = { rows: t.skipped ? Number(t.manifest.rows) || 0 : rowsOf.get(name).length, by_disposition: Object.fromEntries(Object.entries(by).sort((x, y) => byCodePoint(x[0], y[0]))), ...(t.skipped ? { skipped: t.skipped } : {}) };
  }
  const coverage = total === 0 ? 1 : covered / total;
  const fileCount = books.reduce((s, b) => s + b.files.length, 0);
  return {
    importer_version: IMPORTER_VERSION,
    dump: { sha256: dump.manifestSha256, dumper_version: dump.manifest.dumper_version ?? null },
    books,
    dispositions: dispositionList,
    issues,
    summary: { tables: summaryTables, files: fileCount, coverage },
    chapters: chapterInfo.map((c) => {
      const b = builders.get([...builders.keys()].find((k) => builders.get(k).b.slug === c.book));
      const ch = b.chapters.find((x) => x.c.id === c.legacy_id);
      return { ...c, scenes: ch.scenes.map((s) => ({ path: s.path, id: s.id, sequence: s.sequence, kind: s.kind, body: s.body, glue_after: s.glueAfter })) };
    }),
  };
}

/** The planned files as a Map<path, Buffer> (a library layout: every path starts with its book root). @param {{ books: { files: { path: string, bytes: Buffer }[] }[] }} plan */
export function planToTree(plan) {
  const tree = new Map();
  for (const b of plan.books) for (const f of b.files) tree.set(f.path, f.bytes);
  return tree;
}

/** One sha256 over every planned path and file hash, in path order: the golden "tree hash". @param {{ books: { files: { path: string, sha256: string }[] }[] }} plan */
export function treeHash(plan) {
  const lines = plan.books.flatMap((b) => b.files).sort((x, y) => byCodePoint(x.path, y.path)).map((f) => `${f.path}\0${f.sha256}\n`);
  return sha256Hex(Buffer.from(lines.join(''), 'utf8'));
}
