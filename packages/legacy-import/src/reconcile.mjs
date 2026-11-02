// reconcile: check a written v2 library against the legacy dump, INDEPENDENTLY of the import plan (M06-J02 contract sections 2 and 3).
// The expected side comes from the dump rows (plus the J01 pure helpers: deterministic ids, slugs, the scene split rules, chapter ordering);
// the actual side is read from the files on disk. The plan is consulted only to EXPLAIN rows that were not converted (dispositions and
// issue codes); its file list and bytes are never used. Reports carry ids, paths, counts and hashes, never text of the books.
import fs from 'node:fs';
import path from 'node:path';
import { loadDoc } from '@storyforge/format';
import { colText, readDump } from './dump.mjs';
import { planImport } from './plan.mjs';
import { splitChapter } from './split.mjs';
import { byCodePoint, chRef, compareIds, compareKeys, deterministicId, numKey, sha256Hex, slugify } from './util.mjs';

export const CHECK_NAMES = ['counts', 'ids', 'order', 'text-hashes', 'codex-links', 'notes-comments', 'archive-revisions', 'coverage'];

const MAX_DETAILS = 20;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g;
const LINK_ISSUE_RE = /^(link-|unknown-link$)/;
const ID_LIKE_RE = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATE_WORDS = new Set(['died', 'revived', 'destroyed', 'lost', 'found', 'holder', 'location']);

const str = (row, key) => colText(row[key]);
const idOf = (row, index) => (row.id !== undefined && row.id !== null ? String(row.id) : String(index + 1));
const numOr = (v, d) => {
  const n = Number(colText(v));
  return colText(v) !== '' && Number.isFinite(n) ? n : d;
};
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim();
const sha = (s) => sha256Hex(Buffer.from(s, 'utf8'));
const short = (h) => h.slice(0, 12);
const bySortThenId = (x, y) => numOr(x.row.sort_order, 0) - numOr(y.row.sort_order, 0) || compareIds(x.id, y.id);

/** The text after the front matter, byte for byte (nothing is trimmed). */
function bodyAfterFrontMatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  if (end >= 0) return text.slice(end + 5);
  return text.endsWith('\n---') ? '' : text;
}

/** [[targets]] outside fenced code and inline code. */
function wikiTargets(body) {
  const out = [];
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
      const t = w[1].split('|')[0].trim();
      if (t !== '') out.push(t);
    }
  }
  return out;
}

/** Every file of one book folder: relative posix path -> { rel, text, fm, kind, body }. `.storyforge/` is skipped. */
async function readBookFiles(bookDir) {
  const files = new Map();
  const walk = async (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.storyforge') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, r);
        continue;
      }
      const isMd = e.name.endsWith('.md');
      if (!isMd && !e.name.endsWith('.jsonl')) continue;
      const text = fs.readFileSync(abs, 'utf8');
      let fm = null;
      if (isMd) {
        const { doc } = await loadDoc(abs, r, r, () => {});
        fm = doc ? doc.fm : null;
      }
      files.set(r, { rel: r, text, fm, schema: typeof fm?.schema === 'string' ? fm.schema : null, body: isMd ? bodyAfterFrontMatter(text) : text });
    }
  };
  await walk(path.resolve(bookDir), '');
  return files;
}

/** A check under construction: totals of legacy vs v2, failing items, explained items. */
function newCheck(name) {
  const c = { name, legacy: 0, v2: 0, ok: true, problems: [], explained: [], rows: [] };
  c.cmp = (item, l, v, why) => {
    c.legacy += l;
    c.v2 += v;
    c.rows.push({ item, legacy: l, v2: v });
    if (l === v) return;
    if (why) c.explained.push(`${item}: ${l} in the dump, ${v} on disk (${why})`);
    else c.problems.push(`${item}: ${l} in the dump, ${v} on disk`);
  };
  c.fail = (text) => c.problems.push(text);
  c.note = (text) => c.explained.push(text);
  c.finish = (withRows) => {
    const out = { name, legacy: c.legacy, v2: c.v2, ok: c.problems.length === 0 };
    if (c.explained.length) out.explained = c.explained.length > 5 ? `${c.explained.slice(0, 5).join('; ')}; and ${c.explained.length - 5} more` : c.explained.join('; ');
    if (c.problems.length) out.details = c.problems.slice(0, MAX_DETAILS).concat(c.problems.length > MAX_DETAILS ? [`and ${c.problems.length - MAX_DETAILS} more`] : []);
    if (withRows && c.rows.length) out.rows = c.rows;
    return out;
  };
  return c;
}

/**
 * @param {string} dumpDir @param {string} libraryDir @param {{ books?: string[] }} [options]
 * @returns {Promise<{ dump: { sha256: string }, library: string, books: { legacy_id: string, slug: string, checks: any[] }[], unexplained: number }>}
 */
export async function reconcile(dumpDir, libraryDir, options = {}) {
  const dump = readDump(dumpDir);
  const plan = planImport(dumpDir, { books: options.books }); // only for dispositions and issue codes that EXPLAIN a difference
  const lib = path.resolve(libraryDir);

  const disp = new Map(plan.dispositions.map((d) => [`${d.table}\u0000${d.id}`, d]));
  const linkIssuePaths = new Set(plan.issues.filter((i) => LINK_ISSUE_RE.test(i.code) && i.path).map((i) => i.path));
  const linkIssueRows = new Set(plan.issues.filter((i) => LINK_ISSUE_RE.test(i.code) && i.table).map((i) => `${i.table}\u0000${i.id ?? ''}`));
  const issueRows = (code) => new Set(plan.issues.filter((i) => i.code === code && i.table).map((i) => `${i.table}\u0000${i.id ?? ''}`));
  const relatedIssues = issueRows('related-unresolved');

  /** rows of a dumped table: { row, id, raw } */
  const rows = (name) => {
    const t = dump.tables.get(name);
    return t ? t.rows.map((row, i) => ({ row, id: idOf(row, i), raw: t.raw[i] })) : [];
  };

  // ---- books -------------------------------------------------------------------------------------------------------------------
  const used = new Set();
  const allBooks = rows('books').map((b) => {
    const base = slugify(str(b.row, 'folder')) || slugify(b.id) || slugify(str(b.row, 'title')) || 'book';
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 56)}-${n}`;
    used.add(slug);
    return { b, legacy_id: b.id, slug, folder: str(b.row, 'folder') };
  });
  const wanted = options.books && options.books.length ? options.books : null;
  const selected = wanted ? allBooks.filter((x) => wanted.some((w) => w === x.legacy_id || w === x.folder || w === x.slug || slugify(w) === x.slug)) : allBooks;
  const bookIds = new Set(allBooks.map((x) => x.legacy_id));

  const entryBook = new Map(rows('entries').map((e) => [e.id, str(e.row, 'book_id')]));
  const taskBook = new Map(rows('tasks').map((t) => [t.id, str(t.row, 'book_id')]));
  const chapterBook = new Map(rows('chapters').map((c) => [c.id, str(c.row, 'book_id')]));
  const chapterBookByFile = new Map(rows('chapters').map((c) => [str(c.row, 'file'), str(c.row, 'book_id')]));
  const ownerOf = (table, row) => {
    let o = null;
    if (table === 'books') o = str(row, 'id');
    else if (['entry_fields', 'entry_sections', 'entry_relations'].includes(table)) o = entryBook.get(str(row, 'entry_id')) ?? null;
    else if (table === 'task_steps') o = taskBook.get(str(row, 'task_id')) ?? null;
    else if (table === 'chapter_revisions') o = str(row, 'book_id') || chapterBook.get(str(row, 'chapter_id')) || chapterBookByFile.get(str(row, 'chapter_file')) || null;
    else if (['scenes', 'exercises', 'prose_analysis'].includes(table) && row.chapter_id !== undefined && !str(row, 'book_id')) o = chapterBook.get(str(row, 'chapter_id')) ?? null;
    else if (row.book_id !== undefined && str(row, 'book_id') !== '') o = str(row, 'book_id');
    return o && bookIds.has(o) ? o : null;
  };

  const result = { dump: { sha256: dump.manifestSha256 }, library: lib, books: [], unexplained: 0 };
  for (const [bi, B] of selected.entries()) {
    const bid = B.legacy_id;
    const first = bi === 0;
    const mine = (table) => rows(table).filter((r) => {
      const o = ownerOf(table, r.row);
      return o === bid || (o === null && first && table === 'captures');
    });
    const files = await readBookFiles(path.join(lib, B.slug));
    const all = [...files.values()];
    const byId = new Map();
    for (const f of all) if (typeof f.fm?.id === 'string') byId.set(f.fm.id, [...(byId.get(f.fm.id) ?? []), f]);
    const one = (id) => byId.get(id)?.[0] ?? null;
    const withSchema = (s) => all.filter((f) => f.schema === `storyforge.${s}/v1`);
    const filePath = (f) => `${B.slug}/${f.rel}`;
    const linkExplained = (f, table, id) => linkIssuePaths.has(filePath(f)) || (table && linkIssueRows.has(`${table}\u0000${id}`));

    // ---------------- the dump side ----------------
    const chRows = mine('chapters');
    const isReadme = (c) => /readme\.md$/i.test(str(c.row, 'file'));
    const isArchivedRow = (c) => str(c.row, 'status') === 'archived';
    const order = (list) => [...list].sort((x, y) => numOr(x.row.sort_order, 9999) - numOr(y.row.sort_order, 9999) || compareKeys(numKey(str(x.row, 'num')), numKey(str(y.row, 'num'))) || compareIds(x.id, y.id));
    const real = chRows.filter((c) => !isReadme(c));
    const chapters = [...order(real.filter((c) => !isArchivedRow(c))), ...order(real.filter(isArchivedRow))].map((c, i) => {
      const body = str(c.row, 'body');
      const segs = splitChapter(body);
      return {
        c, n: i + 1, id: deterministicId('chap', 'chapters', c.id), arch: isArchivedRow(c), num: str(c.row, 'num'), body, segs,
        sceneIds: segs.map((_, k) => deterministicId('scene', 'chapters/scene', `${c.id}#${k + 1}`)),
      };
    });
    const chapterByRef = (s) => {
      const r = chRef(s);
      if (r === null || r === '') return null;
      return chapters.find((c) => !c.arch && chRef(c.num) === r) ?? chapters.find((c) => chRef(c.num) === r) ?? null;
    };
    const entries = mine('entries').map((e) => ({ e, id: deterministicId('entry', 'entries', e.id), db: str(e.row, 'db_key') }));
    const ledger = mine('story_ledger');
    const progs = mine('progressions');
    const stateRows = mine('state_events');
    const knowRows = mine('knowledge_facts');
    const progIds = new Set(progs.map((p) => deterministicId('event', 'progressions', p.id)));
    // events the importer creates for state changes that hang on no progression
    const progChapters = new Set(progs.map((p) => chapterByRef(str(p.row, 'chapter'))).filter(Boolean));
    const createdKeys = new Set();
    for (const s of stateRows) {
      const ch = chapterByRef(str(s.row, 'chapter'));
      createdKeys.add(ch ? (progChapters.has(ch) ? null : `chapter:${ch.c.id}`) : 'unplaced');
    }
    for (const k of knowRows) {
      if (str(k.row, 'learned_in') === '') createdKeys.add('before');
      else {
        const ch = chapterByRef(str(k.row, 'learned_in'));
        createdKeys.add(ch ? (progChapters.has(ch) ? null : `chapter:${ch.c.id}`) : 'unplaced');
      }
    }
    createdKeys.delete(null);
    const createdId = (key) => deterministicId('event', 'legacy/event', `${bid}:${key}`);
    const createdCandidates = new Set([createdId('before'), createdId('unplaced'), ...chapters.map((c) => createdId(`chapter:${c.c.id}`))]);

    // revision rows of this book
    const revTables = [['chapter_revisions', 'chapters'], ['entry_revisions', 'entries'], ['workspace_revisions', 'workspace']];
    const revRows = revTables.map(([table, dir]) => ({ table, dir, list: mine(table) }));
    const history = new Map();
    for (const f of all) if (f.rel.startsWith('legacy/history/') && f.fm?.legacy_table !== undefined) history.set(`${f.fm.legacy_table}|${f.fm.legacy_id}`, [...(history.get(`${f.fm.legacy_table}|${f.fm.legacy_id}`) ?? []), f]);

    // ---------------- disk groups ----------------
    const diskChapters = withSchema('chapter');
    const diskScenes = withSchema('scene');
    const scenesOfN = (n) => diskScenes.filter((f) => f.fm.chapter === n).sort((x, y) => numOr(x.fm.sequence, 0) - numOr(y.fm.sequence, 0) || byCodePoint(x.rel, y.rel));
    const diskEntries = withSchema('entry');
    const diskEvents = withSchema('event');
    const slugSet = new Set();
    const slugToSlug = new Map();
    const slugged = [...diskEntries, ...withSchema('thread'), ...diskEvents].filter((f) => typeof f.fm.slug === 'string');
    for (const f of slugged) {
      slugSet.add(f.fm.slug);
      slugToSlug.set(f.fm.slug, f.fm.slug);
    }
    for (const f of slugged) for (const p of Array.isArray(f.fm.previous_slugs) ? f.fm.previous_slugs : []) if (!slugToSlug.has(String(p))) slugToSlug.set(String(p), f.fm.slug);
    const resolveSlug = (t) => slugToSlug.get(t) ?? slugToSlug.get(slugify(t)) ?? null;
    const dirOf = (prefix) => all.filter((f) => f.rel.startsWith(prefix) && f.rel.endsWith('.md'));
    const checks = [];

    // ======== 1. counts ========
    {
      const c = newCheck('counts');
      const diskCh = (arch) => diskChapters.filter((f) => f.rel.startsWith('archive/') === arch).length;
      c.cmp('chapters (live)', chapters.filter((x) => !x.arch).length, diskCh(false));
      c.cmp('chapters (archived)', chapters.filter((x) => x.arch).length, diskCh(true));
      let legacyScenes = 0;
      const bad = [];
      for (const ch of chapters) {
        legacyScenes += ch.segs.length;
        const got = scenesOfN(ch.n).length;
        if (got !== ch.segs.length) bad.push(`chapter ${ch.c.id}: ${ch.segs.length} scenes in the dump, ${got} on disk`);
      }
      c.cmp('scenes', legacyScenes, diskScenes.length);
      for (const x of bad) c.fail(x);
      const dbKeys = new Set([...entries.map((e) => e.db), ...diskEntries.map((f) => String(f.fm['x-legacy-db'] ?? ''))]);
      for (const k of [...dbKeys].sort(byCodePoint)) c.cmp(`entries (${k || 'no type'})`, entries.filter((e) => e.db === k).length, diskEntries.filter((f) => String(f.fm['x-legacy-db'] ?? '') === k).length);
      c.cmp('note_pages', mine('note_pages').length, dirOf('planning/notes/').length);
      c.cmp('meta_pages', mine('meta_pages').length, dirOf('planning/meta/').length);
      const wsRows = mine('workspace_docs');
      c.cmp('workspace_docs', wsRows.length, wsRows.filter((r) => one(deterministicId('note', 'workspace_docs', r.id))).length);
      c.cmp('tasks', mine('tasks').length, dirOf('planning/tasks/').length);
      const dictFile = files.get('planning/dictionary.md');
      c.cmp('dictionary_terms', mine('dictionary_terms').length, dictFile ? dictFile.body.split('\n').filter((l) => l.startsWith('- ')).length : 0);
      c.cmp('comments', mine('chapter_notes').length, dirOf('planning/legacy/comments/').reduce((s, f) => s + (f.body.match(/^## Comment \S+ \(/gm) ?? []).length, 0));
      c.cmp('events (progressions)', progs.length, diskEvents.filter((f) => progIds.has(f.fm.id)).length);
      c.cmp('events (created for state changes)', createdKeys.size, diskEvents.filter((f) => !progIds.has(f.fm.id)).length);
      c.cmp('threads', ledger.length, withSchema('thread').length);
      c.cmp('sources', mine('sources').length, withSchema('source').length);
      const logFile = files.get('activity/writing-log.md');
      const sessions = logFile ? logFile.body.split('\n').reduce((s, l) => s + Number(/^\|.*\|\s*(\d+)\s*\|\s*$/.exec(l)?.[1] ?? 0), 0) : 0;
      c.cmp('writing_log rows', mine('writing_log').length, sessions);
      for (const rv of revRows) c.cmp(`history files (${rv.dir})`, rv.list.length, all.filter((f) => f.rel.startsWith(`legacy/history/${rv.dir}/`)).length);
      checks.push(c.finish(true));
    }

    // ======== 2. ids ========
    {
      const c = newCheck('ids');
      const expected = new Map();
      const want = (id, label) => expected.set(id, label);
      want(deterministicId('book', 'books', bid), `books#${bid}`);
      for (const a of mine('acts')) want(deterministicId('act', 'acts', a.id), `acts#${a.id}`);
      for (const ch of chapters) {
        want(ch.id, `chapters#${ch.c.id}`);
        ch.sceneIds.forEach((id, k) => want(id, `chapters#${ch.c.id} scene ${k + 1}`));
      }
      for (const e of entries) want(e.id, `entries#${e.e.id}`);
      for (const l of ledger) want(deterministicId('thread', 'story_ledger', l.id), `story_ledger#${l.id}`);
      for (const p of progs) want(deterministicId('event', 'progressions', p.id), `progressions#${p.id}`);
      for (const t of ['sources', 'note_pages', 'meta_pages', 'workspace_docs', 'tasks']) for (const r of mine(t)) want(deterministicId('note', t, r.id), `${t}#${r.id}`);
      const single = (table, has, label) => {
        if (has) want(deterministicId('note', table, bid), label);
      };
      single('continuity_exemptions', mine('continuity_exemptions').length > 0, 'continuity_exemptions (one file)');
      single('writing_log', mine('writing_log').length > 0, 'writing_log (one file)');
      single('canvas_cards', mine('canvas_cards').length + mine('canvas_links').length > 0, 'canvas (one file)');
      single('vision_items', mine('vision_items').length > 0, 'vision_items (one file)');
      single('captures', mine('captures').length > 0, 'captures (one file)');
      single('dictionary_terms', mine('dictionary_terms').length > 0, 'dictionary_terms (one file)');
      for (const key of createdKeys) want(createdId(key), `created event ${key.replace(/^chapter:/, 'chapter ')}`);
      const allowed = new Set(createdCandidates);
      for (const f of dirOf('planning/legacy/comments/')) allowed.add(deterministicId('note', 'chapter_notes', `${bid}:${path.posix.basename(f.rel, '.md')}`));
      let found = 0;
      for (const [id, label] of expected) {
        const n = byId.get(id)?.length ?? 0;
        if (n === 1) found += 1;
        else c.fail(n === 0 ? `missing: ${label} (${id})` : `appears ${n} times: ${label} (${id})`);
      }
      c.legacy = expected.size;
      c.v2 = found;
      for (const [id, fl] of byId) {
        if (fl.length > 1 && !expected.has(id)) c.fail(`appears ${fl.length} times: ${id}`);
        if (!expected.has(id) && !allowed.has(id)) c.fail(`${fl[0].rel} has the id ${id}, which maps to no legacy row`);
      }
      checks.push(c.finish());
    }

    // ======== 3. order ========
    {
      const c = newCheck('order');
      const present = chapters.filter((x) => one(x.id));
      const diskOrder = [...diskChapters].sort((x, y) => numOr(x.fm.chapter, 0) - numOr(y.fm.chapter, 0) || byCodePoint(x.rel, y.rel)).map((f) => f.fm.id).filter((id) => present.some((x) => x.id === id));
      present.forEach((x, i) => {
        c.legacy += 1;
        if (diskOrder[i] === x.id && one(x.id).fm.chapter === x.n) c.v2 += 1;
        else c.fail(`chapter ${x.c.id}: expected position ${x.n}, the library has ${one(x.id).fm.chapter} (order position ${diskOrder.indexOf(x.id) + 1})`);
      });
      for (const x of present) {
        c.legacy += 1;
        const got = String(one(x.id).fm['x-legacy-num'] ?? '');
        if (got === x.num) c.v2 += 1;
        else c.fail(`chapter ${x.c.id}: x-legacy-num is "${got}" but the dump has "${x.num}"`);
      }
      for (const x of chapters) {
        const disk = scenesOfN(x.n);
        const diskIds = disk.map((f) => f.fm.id).filter((id) => x.sceneIds.includes(id));
        const expectedIds = x.sceneIds.filter((id) => diskIds.includes(id));
        c.legacy += x.sceneIds.length;
        let ok = 0;
        expectedIds.forEach((id, i) => {
          if (diskIds[i] === id) ok += 1;
        });
        c.v2 += ok;
        if (ok !== x.sceneIds.length) c.fail(`chapter ${x.c.id}: scene order differs from the dump (${ok} of ${x.sceneIds.length} scenes in place)`);
        const seqs = disk.map((f) => numOr(f.fm.sequence, 0));
        if (seqs.some((s, i) => i > 0 && s <= seqs[i - 1])) c.fail(`chapter ${x.c.id}: scene sequence numbers are not strictly increasing`);
      }
      checks.push(c.finish());
    }

    // ======== 4. text hashes ========
    const entryRowFound = new Map(); // `${table}\u0000${id}` -> boolean, shared with coverage
    {
      const c = newCheck('text-hashes');
      for (const x of chapters) {
        const disk = scenesOfN(x.n);
        const bodies = disk.map((f) => f.body);
        const joined = bodies.map((b, i) => b + (i < bodies.length - 1 ? (x.segs[i]?.glue ?? '') : '')).join('');
        const want = sha(x.body);
        const got = sha(joined);
        c.legacy += 1;
        if (want === got) c.v2 += 1;
        else c.fail(`chapter ${x.c.id}: body sha256 ${short(want)} in the dump, ${short(got)} rebuilt from the scene files`);
        if (bodies.length === x.segs.length) {
          x.segs.forEach((s, i) => {
            c.legacy += 1;
            if (sha(s.body) === sha(bodies[i])) c.v2 += 1;
            else c.fail(`chapter ${x.c.id} scene ${i + 1} (${disk[i].rel}): sha256 ${short(sha(s.body))} in the dump, ${short(sha(bodies[i]))} on disk`);
          });
        }
      }
      // entries
      const fieldsOf = new Map();
      const sectionsOf = new Map();
      for (const f of rows('entry_fields').sort(bySortThenId)) fieldsOf.set(str(f.row, 'entry_id'), [...(fieldsOf.get(str(f.row, 'entry_id')) ?? []), f]);
      for (const f of rows('entry_sections').sort(bySortThenId)) sectionsOf.set(str(f.row, 'entry_id'), [...(sectionsOf.get(str(f.row, 'entry_id')) ?? []), f]);
      for (const en of entries) {
        const f = one(en.id);
        if (!f) continue;
        const secs = sectionsOf.get(en.e.id) ?? [];
        const expectedBody = secs.map((s) => `## ${str(s.row, 'heading')}\n${str(s.row, 'body').replace(/^\n+|\n+$/g, '')}`.trimEnd()).join('\n\n');
        const diskBody = f.body.replace(/\n$/, '').replace(/(^|\n\n)<!-- legacy related not applied: [^]*? -->$/, '');
        c.legacy += 1;
        if (sha(expectedBody) === sha(diskBody)) c.v2 += 1;
        else if (linkExplained(f, 'entries', en.e.id)) {
          c.v2 += 1;
          c.note(`entry ${en.e.id}: text differs only where a link was rewritten (${filePath(f)})`);
        } else c.fail(`entry ${en.e.id} (${f.rel}): sections sha256 ${short(sha(expectedBody))} in the dump, ${short(sha(diskBody))} on disk`);
        let cursor = 0;
        for (const s of secs) {
          const h = `## ${str(s.row, 'heading')}`;
          const at = f.body.indexOf(h, cursor);
          entryRowFound.set(`entry_sections\u0000${s.id}`, at >= 0);
          if (at >= 0) cursor = at + h.length;
        }
        const legacyFields = (fieldsOf.get(en.e.id) ?? []).map((r) => sha(str(r.row, 'value'))).sort();
        const diskFields = Object.values(f.fm.fields && typeof f.fm.fields === 'object' ? f.fm.fields : {}).map((v) => sha(String(v))).sort();
        (fieldsOf.get(en.e.id) ?? []).forEach((r, i) => entryRowFound.set(`entry_fields\u0000${r.id}`, i < diskFields.length));
        c.legacy += 1;
        if (legacyFields.join() === diskFields.join()) c.v2 += 1;
        else if (legacyFields.length === diskFields.length && linkExplained(f, 'entries', en.e.id)) {
          c.v2 += 1;
          c.note(`entry ${en.e.id}: a field differs only where a link was rewritten (${filePath(f)})`);
        } else c.fail(`entry ${en.e.id} (${f.rel}): ${legacyFields.length} field(s) in the dump, ${diskFields.length} on disk, or a field value differs`);
      }
      // documents: note_pages, meta_pages, workspace_docs
      for (const table of ['note_pages', 'meta_pages', 'workspace_docs']) {
        for (const r of mine(table)) {
          const f = one(deterministicId('note', table, r.id));
          if (!f) continue;
          const want = str(r.row, 'body');
          c.legacy += 1;
          if (f.body === want || f.body === `${want}\n`) c.v2 += 1;
          else if (linkExplained(f, table, r.id)) {
            c.v2 += 1;
            c.note(`${table}#${r.id}: text differs only where a link was rewritten`);
          } else c.fail(`${table}#${r.id} (${f.rel}): sha256 ${short(sha(want))} in the dump, ${short(sha(f.body))} on disk`);
        }
      }
      // revisions
      for (const rv of revRows) {
        for (const r of rv.list) {
          const f = history.get(`${rv.table}|${r.id}`)?.[0];
          if (!f) continue;
          const want = str(r.row, 'body');
          c.legacy += 1;
          if (f.body === want) c.v2 += 1;
          else c.fail(`${rv.table}#${r.id} (${f.rel}): sha256 ${short(sha(want))} in the dump, ${short(sha(f.body))} on disk`);
        }
      }
      checks.push(c.finish());
    }

    // ======== 5. codex links ========
    const relationFound = new Map();
    {
      const c = newCheck('codex-links');
      const relsOf = new Map();
      for (const r of rows('entry_relations').sort(bySortThenId)) relsOf.set(str(r.row, 'entry_id'), [...(relsOf.get(str(r.row, 'entry_id')) ?? []), r]);
      let legacyRows = 0;
      let written = 0;
      let listed = 0;
      let dups = 0;
      for (const en of entries) {
        const rels = relsOf.get(en.e.id) ?? [];
        legacyRows += rels.length;
        const f = one(en.id);
        const toSet = new Set((f && Array.isArray(f.fm.related) ? f.fm.related : []).map((x) => x?.to));
        const notApplied = new Set();
        const m = f ? /<!-- legacy related not applied: ([^]*?) -->/.exec(f.body) : null;
        if (m) for (const t of m[1].split(',')) notApplied.add(t.trim());
        const seen = new Set();
        for (const r of rels) {
          const target = str(r.row, 'target_slug');
          const slug = resolveSlug(target);
          let kind = 'missing';
          if (slug && toSet.has(slug)) kind = seen.has(slug) ? 'dup' : 'written';
          else if (notApplied.has(target)) kind = 'listed';
          if (slug) seen.add(slug);
          relationFound.set(`entry_relations\u0000${r.id}`, kind !== 'missing');
          if (kind === 'written') written += 1;
          else if (kind === 'dup') dups += 1;
          else if (kind === 'listed') {
            if (relatedIssues.has(`entries\u0000${en.e.id}`)) listed += 1;
            else c.fail(`entry ${en.e.id}: relation to "${target}" is only a comment, and the plan names no related-unresolved issue for it`);
          } else c.fail(`entry ${en.e.id}: relation to "${target}" is not written as a related item and not listed as unresolved`);
        }
      }
      c.legacy = legacyRows;
      c.v2 = written + dups + listed;
      if (listed) c.note(`${listed} relation(s) listed as unresolved (related-unresolved)`);
      if (dups) c.note(`${dups} repeated relation(s) folded into one related item`);
      // every related target and every [[link]] resolves
      for (const f of all) {
        if (f.rel.startsWith('legacy/') || f.rel.startsWith('.')) continue;
        if (!f.rel.endsWith('.md')) continue;
        for (const rel of Array.isArray(f.fm?.related) ? f.fm.related : []) {
          if (!slugSet.has(rel?.to) && !linkExplained(f)) c.fail(`${f.rel}: related target "${rel?.to}" is not an imported entry`);
        }
        const seen = new Set();
        for (const t of wikiTargets(f.body)) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (slugSet.has(t) || slugToSlug.has(t) || byId.has(t) || t.includes(':') || ID_LIKE_RE.test(t)) continue;
          if (linkExplained(f)) c.note(`${f.rel}: link [[${t}]] is listed with a link issue`);
          else c.fail(`${f.rel}: link [[${t}]] resolves to no imported entry and the plan lists no link issue`);
        }
      }
      checks.push(c.finish());
    }

    // ======== 6. notes and comments ========
    const commentFound = new Map();
    {
      const c = newCheck('notes-comments');
      const noteRows = mine('note_pages');
      let foundNotes = 0;
      for (const r of noteRows) {
        const f = one(deterministicId('note', 'note_pages', r.id));
        const want = str(r.row, 'body');
        if (!f) {
          c.fail(`note_pages#${r.id}: no file`);
          continue;
        }
        if (f.body === want || f.body === `${want}\n` || linkExplained(f, 'note_pages', r.id)) foundNotes += 1;
        else c.fail(`note_pages#${r.id} (${f.rel}): sha256 ${short(sha(want))} in the dump, ${short(sha(f.body))} on disk`);
      }
      c.legacy += noteRows.length;
      c.v2 += foundNotes;
      const blocks = new Map();
      for (const f of dirOf('planning/legacy/comments/')) {
        const parts = f.body.split(/^(?=## Comment \S+ \()/m);
        for (const p of parts) {
          const m = /^## Comment (\S+) \(/.exec(p);
          if (m) blocks.set(m[1], [...(blocks.get(m[1]) ?? []), { f, text: p }]);
        }
      }
      const cn = mine('chapter_notes');
      let foundComments = 0;
      for (const r of cn) {
        const bl = blocks.get(r.id) ?? [];
        if (bl.length !== 1) {
          c.fail(bl.length === 0 ? `chapter_notes#${r.id}: no comment on disk` : `chapter_notes#${r.id}: appears ${bl.length} times`);
          continue;
        }
        const note = str(r.row, 'note').trim();
        const quote = str(r.row, 'quote');
        const text = bl[0].text.trimEnd();
        const tail = note === '' ? '' : text.slice(-note.length);
        const quoteOk = quote === '' || text.includes(quote.split('\n').map((l) => `> ${l}`).join('\n'));
        if ((sha(tail) === sha(note) && quoteOk) || linkExplained(bl[0].f, 'chapter_notes', r.id)) {
          foundComments += 1;
          commentFound.set(r.id, true);
        } else c.fail(`chapter_notes#${r.id} (${bl[0].f.rel}): note sha256 ${short(sha(note))} in the dump, ${short(sha(tail))} on disk${quoteOk ? '' : ', quote differs'}`);
      }
      c.legacy += cn.length;
      c.v2 += foundComments;
      checks.push(c.finish());
    }

    // ======== 7. archive and revisions ========
    {
      const c = newCheck('archive-revisions');
      for (const x of chapters) {
        const f = one(x.id);
        if (!f) continue;
        const scenes = scenesOfN(x.n);
        c.legacy += 1 + scenes.length;
        const wrong = [f, ...scenes].filter((g) => g.rel.startsWith('archive/') !== x.arch);
        c.v2 += 1 + scenes.length - wrong.length;
        if (wrong.length) c.fail(`chapter ${x.c.id}: ${x.arch ? 'archived' : 'live'} in the dump but ${wrong[0].rel.startsWith('archive/') ? 'under' : 'not under'} archive/ (${wrong.length} file(s))`);
      }
      const keys = new Set();
      for (const rv of revRows) {
        for (const r of rv.list) {
          const key = `${rv.table}|${r.id}`;
          keys.add(key);
          const fl = history.get(key) ?? [];
          c.legacy += 1;
          if (fl.length !== 1) c.fail(`${rv.table}#${r.id}: ${fl.length} history file(s), expected exactly 1`);
          else if (!fl[0].rel.startsWith(`legacy/history/${rv.dir}/`)) c.fail(`${rv.table}#${r.id}: history file ${fl[0].rel} is under the wrong folder`);
          else if (String(fl[0].fm.saved_at ?? '') !== str(r.row, 'created_at')) c.fail(`${rv.table}#${r.id}: saved_at "${fl[0].fm.saved_at}" differs from the dump "${str(r.row, 'created_at')}"`);
          else c.v2 += 1;
        }
      }
      for (const [key, fl] of history) if (!keys.has(key)) c.fail(`${fl[0].rel}: a history file for ${key}, which is no revision row of this book`);
      checks.push(c.finish());
    }

    // ======== 8. coverage ========
    {
      const c = newCheck('coverage');
      const inScope = (table, r) => {
        const o = ownerOf(table, r.row);
        return o === bid || (o === null && first);
      };
      // aggregated counts of things written into shared files
      const stateOnDisk = diskEvents.reduce((n, f) => n + (Array.isArray(f.fm.state) ? f.fm.state.filter((s) => STATE_WORDS.has(s?.event)).length : 0) + (f.body.match(/legacy state not applied:/g) ?? []).length, 0);
      const knowOnDisk = diskEvents.reduce((n, f) => n + (Array.isArray(f.fm.state) ? f.fm.state.filter((s) => s?.event === 'learns' || s?.event === 'knows').length : 0) + (f.body.match(/legacy knowledge not applied:/g) ?? []).length, 0);
      const lines = (rel, re) => (files.get(rel) ? files.get(rel).body.split('\n').filter((l) => re.test(l)).length : 0);
      const boardFile = files.get('planning/board.md');
      const aggregate = {
        state_events: stateOnDisk,
        knowledge_facts: knowOnDisk,
        canvas_links: lines('planning/board.md', /^- Card \S+ to card /),
        vision_items: lines('research/vision.md', /^- /),
        captures: lines('planning/inbox.md', /^- \[/),
        dictionary_terms: lines('planning/dictionary.md', /^- /),
        continuity_exemptions: lines('planning/legacy/continuity-exemptions.md', /^- \*\*/),
      };
      const keptRaw = (table) => new Set((files.get(`legacy/tables/${table}.jsonl`)?.text ?? '').split('\n').filter(Boolean));
      const byIdTables = {
        books: () => deterministicId('book', 'books', bid), acts: (r) => deterministicId('act', 'acts', r.id), chapters: (r) => deterministicId('chap', 'chapters', r.id),
        entries: (r) => deterministicId('entry', 'entries', r.id), story_ledger: (r) => deterministicId('thread', 'story_ledger', r.id),
        progressions: (r) => deterministicId('event', 'progressions', r.id), sources: (r) => deterministicId('note', 'sources', r.id),
        note_pages: (r) => deterministicId('note', 'note_pages', r.id), meta_pages: (r) => deterministicId('note', 'meta_pages', r.id),
        workspace_docs: (r) => deterministicId('note', 'workspace_docs', r.id), tasks: (r) => deterministicId('note', 'tasks', r.id),
      };
      const aggUsed = {};
      const tally = {};
      const bump = (k) => {
        tally[k] = (tally[k] ?? 0) + 1;
      };
      let legacyTotal = 0;
      let accounted = 0;
      const missing = [];
      const tableNames = [...dump.tables.keys()];
      for (const table of tableNames) {
        const t = dump.tables.get(table);
        if (t.skipped) {
          if (first) {
            const n = Number(t.manifest.rows) || 0;
            legacyTotal += n;
            accounted += n;
            if (n) tally[`${t.skipped}`] = (tally[`${t.skipped}`] ?? 0) + n;
          }
          continue;
        }
        for (const r of rows(table)) {
          if (!inScope(table, r)) continue;
          legacyTotal += 1;
          const k = `${table}\u0000${r.id}`;
          let found = false;
          if (table === 'chapters' && isReadme(r)) found = false;
          else if (byIdTables[table]) found = Boolean(one(byIdTables[table](r)));
          else if (entryRowFound.has(k)) found = entryRowFound.get(k);
          else if (table === 'entry_relations') found = relationFound.get(k) === true;
          else if (table === 'task_steps') {
            const f = one(deterministicId('note', 'tasks', str(r.row, 'task_id')));
            found = Boolean(f && f.body.includes(`- [${numOr(r.row.done, 0) ? 'x' : ' '}] ${oneLine(str(r.row, 'text'))}`));
          } else if (table === 'chapter_cast') {
            const ch = chapters.find((x) => str(x.c.row, 'file') === str(r.row, 'chapter_file'));
            found = Boolean(ch && one(ch.id) && (ch.segs.length === 0 || scenesOfN(ch.n).some((f) => f.fm['x-legacy-cast-review'] === true)));
          } else if (table === 'chapter_notes') found = commentFound.get(r.id) === true;
          else if (table === 'canvas_cards') found = Boolean(boardFile && boardFile.body.includes(`- **Card ${r.id}**`));
          else if (table === 'writing_log') found = keptRaw('writing_log').has(r.raw);
          else if (table in aggregate) {
            aggUsed[table] = (aggUsed[table] ?? 0) + 1;
            found = aggUsed[table] <= aggregate[table];
          } else if (table.endsWith('_revisions')) found = (history.get(`${table}|${r.id}`) ?? []).length === 1;
          const d = disp.get(k);
          if (!found && d?.disposition === 'merged' && d.target && files.has(d.target.slice(B.slug.length + 1))) found = true;
          if (found) {
            accounted += 1;
            continue;
          }
          if (d && (d.disposition === 'derived' || d.disposition === 'server-only' || (d.disposition === 'skipped' && d.reason))) {
            accounted += 1;
            bump(d.disposition);
          } else if (d?.disposition === 'kept-as-data' && keptRaw(table).has(r.raw)) {
            accounted += 1;
            bump('kept-as-data');
          } else missing.push(`${table}#${r.id}: not found on disk${d ? ` (disposition ${d.disposition})` : ' (no disposition)'}`);
        }
      }
      c.legacy = legacyTotal;
      c.v2 = accounted;
      for (const m of missing) c.fail(m);
      const parts = Object.entries(tally).sort((x, y) => byCodePoint(x[0], y[0])).map(([k, n]) => `${n} ${k}`);
      if (parts.length) c.note(`not converted, accounted by the plan: ${parts.join(', ')}`);
      checks.push(c.finish());
    }

    result.books.push({ legacy_id: bid, slug: B.slug, checks });
    result.unexplained += checks.filter((x) => !x.ok).length;
  }
  return result;
}
