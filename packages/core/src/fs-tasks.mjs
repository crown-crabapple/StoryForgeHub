// Revision tasks (M07-J02 section 4): `planning/tasks/<slug>.md`, made from a continuity or author-check finding or by hand.
// A task is its own file: making, opening or finishing one never writes anything else, and never touches prose. Everything goes through @storyforge/store.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { checkContinuity } from '@storyforge/continuity';
import { extractDocs, validate } from '@storyforge/format';
import { editFrontMatterLine, slugify, ulid } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';
import { parseFrontMatter } from './fm.mjs';
import { isoSecond } from './sessions.mjs';
import { locateTarget, notFoundMessage } from './task-locate.mjs';

export const TASKS_DIR = 'planning/tasks';
export const TASK_STATUSES = ['open', 'doing', 'done', 'dropped'];
const TASK_SCHEMA = 'storyforge.task/v1';
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f]`);
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);
/** One line of text as a YAML value: plain when that is safe, else a double-quoted string (JSON escapes are valid YAML). */
const yamlText = (v) => (/^[A-Za-z][A-Za-z0-9 .,'()_-]*$/.test(v) && v === v.trim() && !RESERVED.has(v.toLowerCase()) ? v : JSON.stringify(v));
const errKey = (d) => `${d.code}|${d.file}|${d.location ?? ''}`;
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clip = (s, n = 160) => (s.length <= n ? s : s.slice(0, n));

/** What the pages show of one task file, or null when the file is not a task. @param {string} rel @param {{ bytes: Buffer, sha256: string }} file */
function summarise(rel, file) {
  const { fm, body } = parseFrontMatter(file.bytes.toString('utf8'));
  if (fm.schema !== TASK_SCHEMA || typeof fm.id !== 'string') return null;
  const source = isMap(fm.source) ? fm.source : null;
  return {
    id: fm.id,
    slug: typeof fm.slug === 'string' ? fm.slug : path.posix.basename(rel, '.md'),
    title: typeof fm.title === 'string' ? fm.title : path.posix.basename(rel, '.md'),
    status: TASK_STATUSES.includes(fm.status) ? fm.status : 'open',
    source: source ? { kind: typeof source.kind === 'string' ? source.kind : 'manual', code: typeof source.code === 'string' ? source.code : null, fingerprint: typeof source.fingerprint === 'string' ? source.fingerprint : null } : { kind: 'manual', code: null, fingerprint: null },
    targets: (Array.isArray(fm.targets) ? fm.targets : []).filter((t) => isMap(t) && typeof t.id === 'string').map((t) => ({
      id: t.id, line: Number.isInteger(t.line) ? t.line : null, quote: typeof t.quote === 'string' ? t.quote : null, sha256: typeof t.sha256 === 'string' ? t.sha256 : null,
    })),
    created: fm.created === undefined || fm.created === null ? null : String(fm.created),
    labels: (Array.isArray(fm.labels) ? fm.labels : []).filter((l) => typeof l === 'string'),
    path: rel,
    sha256: file.sha256,
    notes: body.replace(/^\r?\n/, ''),
  };
}

/**
 * Every revision task of a book (files `planning/tasks/*.md` with the task schema), by file name. A legacy planning doc there is not a task.
 * @param {{ list: (rel: string) => Promise<{ name: string, isDirectory: boolean }[]>, read: (rel: string) => Promise<{ bytes: Buffer, sha256: string } | null> }} store
 */
export async function readTasks(store) {
  const out = [];
  const names = (await store.list(TASKS_DIR)).filter((e) => !e.isDirectory && /\.md$/i.test(e.name)).map((e) => e.name).sort();
  for (const name of names) {
    const rel = `${TASKS_DIR}/${name}`;
    const file = await store.read(rel);
    const t = file ? summarise(rel, file) : null;
    if (t) out.push(t);
  }
  return out;
}

/**
 * @param {{ root: string, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>, now?: () => number | Date }} p
 */
export function createTaskMethods({ root, afterWrite = () => {}, reconcile, now = () => Date.now() }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result } : null;
  }
  async function refresh(book) {
    if (reconcile) await reconcile(book.path);
    else afterWrite(book.path);
  }
  /** A task without its notes (the list does not need them). */
  const withoutNotes = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'notes'));

  /**
   * The tasks of a book with the counts per status. Filters: `status` (one of the four), `label`, `source` ('continuity' | 'check' | 'manual').
   * @param {string} bookId @param {{ status?: string, label?: string, source?: string }} [filter]
   */
  async function listTasks(bookId, filter = {}) {
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const all = await readTasks(store);
    const fold = (s) => s.trim().toLowerCase();
    const shown = all.filter((t) => (!filter.status || t.status === filter.status) && (!filter.label || t.labels.some((l) => fold(l) === fold(filter.label ?? ''))) && (!filter.source || t.source.kind === filter.source));
    const count = (s) => all.filter((t) => t.status === s).length;
    const labels = [...new Set(all.flatMap((t) => t.labels))].sort();
    return {
      ok: true, code: 'OK', tasks: shown.map(withoutNotes),
      counts: { open: count('open'), doing: count('doing'), done: count('done'), dropped: count('dropped'), total: all.length }, labels,
    };
  }

  /**
   * One task with its notes and where each target is now: the scene (and the selection to make), or why not. Reads only.
   * `ref` is the task's id or slug. @param {string} bookId @param {string} ref
   */
  async function getTask(bookId, ref) {
    const found = await findBook(bookId);
    if (!found || typeof ref !== 'string') return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const task = (await readTasks(store)).find((t) => t.id === ref || t.slug === ref);
    if (!task) return fail('NOT_FOUND');
    const docs = extractDocs(found.result, found.book.path);
    const byId = new Map(docs.filter((d) => typeof d.fm.id === 'string' && !d.archived).map((d) => [d.fm.id, d]));
    const targets = [];
    for (const t of task.targets) {
      const doc = byId.get(t.id);
      if (!doc) {
        targets.push({ id: t.id, kind: null, title: null, path: null, found: false, reason: 'missing', message: 'This document no longer exists in the book.', selection: null, changed: null });
        continue;
      }
      const title = typeof doc.fm.title === 'string' ? doc.fm.title : typeof doc.fm.name === 'string' ? doc.fm.name : doc.rel;
      if (doc.kind !== 'scene') {
        targets.push({ id: t.id, kind: doc.kind, title, path: doc.rel, found: true, reason: 'not_a_scene', message: null, selection: null, changed: null });
        continue;
      }
      const file = await store.read(doc.rel);
      if (!file) {
        targets.push({ id: t.id, kind: 'scene', title, path: doc.rel, found: false, reason: 'missing', message: 'The scene file cannot be read.', selection: null, changed: null });
        continue;
      }
      const at = locateTarget(file.bytes.toString('utf8'), { line: t.line ?? undefined, quote: t.quote ?? undefined });
      targets.push({
        id: t.id, kind: 'scene', title, path: doc.rel, found: at.found, reason: at.reason,
        message: at.found ? null : notFoundMessage(at.reason), selection: at.selection, changed: t.sha256 ? t.sha256 !== file.sha256 : null,
      });
    }
    return { ok: true, code: 'OK', task: withoutNotes(task), notes: task.notes, targets };
  }

  /** Where in a scene file a finding's source points, as a task target: { id, line, quote, sha256 }, or null when the scene is not live. */
  async function targetOf(store, byId, source) {
    const doc = byId.get(source.id);
    if (!doc || doc.kind !== 'scene') return null;
    const file = await store.read(doc.rel);
    if (!file) return null;
    const lines = file.bytes.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
    const lineText = source.line >= 1 && source.line <= lines.length ? lines[source.line - 1] : '';
    let quote = '';
    if (source.range && Number.isInteger(source.range.from) && Number.isInteger(source.range.to)) quote = lineText.slice(source.range.from, source.range.to).trim();
    if (quote === '' && typeof source.excerpt === 'string') {
      const ex = source.excerpt.length >= 160 ? source.excerpt.replace(/…$/, '') : source.excerpt;
      if (ex !== '' && lineText.includes(ex)) quote = ex;
    }
    if (quote === '') quote = clip(lineText.trim());
    if (quote !== '' && !lineText.includes(quote)) quote = '';
    return { id: source.id, line: Number.isInteger(source.line) && source.line >= 1 ? source.line : null, quote: quote || null, sha256: file.sha256 };
  }

  /** The task file's text. */
  function render({ id, slug, title, status, source, targets, created, labels, notes }) {
    const src = `{ kind: ${source.kind}${source.code ? `, code: ${JSON.stringify(source.code)}` : ''}${source.fingerprint ? `, fingerprint: ${source.fingerprint}` : ''} }`;
    const tl = targets.map((t) => `  - { id: ${t.id}${t.line ? `, line: ${t.line}` : ''}${t.quote ? `, quote: ${JSON.stringify(t.quote)}` : ''}${t.sha256 ? `, sha256: ${t.sha256}` : ''} }`);
    const head = ['---', `schema: ${TASK_SCHEMA}`, `id: ${id}`, `slug: ${slug}`, `title: ${yamlText(title)}`, `status: ${status}`, `source: ${src}`];
    head.push(tl.length ? 'targets:' : 'targets: []', ...tl, `created: "${created}"`, `labels: [${labels.map((l) => JSON.stringify(l)).join(', ')}]`, '---');
    return `${head.join('\n')}\n${notes.trim() === '' ? '' : `${notes.trim()}\n`}`;
  }

  /**
   * Make one task. `from`: 'continuity' (`fingerprint`), 'check' (`sceneId` and the report's `finding`), or absent for a manual task (`title`, optional `targets` and `notes`).
   * The same finding cannot make a second open task: TASK_EXISTS carries `existing` so the caller can offer it. Writes only the new task file.
   * Refusals: BAD_ARGS, NOT_FOUND, FINDING_NOT_FOUND, TASK_EXISTS.
   * @param {string} bookId
   * @param {{ from?: 'continuity' | 'check' | 'manual', fingerprint?: string, sceneId?: string, finding?: any, title?: string, notes?: string, labels?: string[], targets?: { id: string, line?: number, quote?: string }[], dryRun?: boolean }} args
   */
  async function createTask(bookId, args = {}) {
    const a = args ?? {};
    const from = a.from ?? 'manual';
    if (!['continuity', 'check', 'manual'].includes(from)) return fail('BAD_ARGS', { message: 'from must be continuity, check or manual' });
    if (a.title !== undefined && a.title !== null && (typeof a.title !== 'string' || CONTROL_RE.test(a.title) || a.title.length > 300)) return fail('BAD_ARGS', { message: 'title must be one line of text (max 300)' });
    if (a.notes !== undefined && a.notes !== null && (typeof a.notes !== 'string' || a.notes.length > 20_000)) return fail('BAD_ARGS', { message: 'notes must be text (up to 20000 characters)' });
    if (a.labels !== undefined && (!Array.isArray(a.labels) || a.labels.length > 20 || a.labels.some((l) => typeof l !== 'string' || l.trim() === '' || CONTROL_RE.test(l) || l.length > 60))) return fail('BAD_ARGS', { message: 'labels must be a list of short names' });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const bookRoot = bookRootOf(found.book);
    const store = await openStore(bookRoot);
    const docs = extractDocs(found.result, found.book.path);
    const byId = new Map(docs.filter((d) => typeof d.fm.id === 'string' && !d.archived).map((d) => [d.fm.id, d]));
    const existing = await readTasks(store);

    let title = typeof a.title === 'string' ? a.title.trim() : '';
    let notes = typeof a.notes === 'string' ? a.notes : '';
    /** @type {{ kind: string, code?: string | null, fingerprint?: string | null }} */
    let source = { kind: 'manual' };
    /** @type {{ id: string, line: number | null, quote: string | null, sha256: string | null }[]} */
    let targets = [];

    if (from === 'continuity') {
      if (typeof a.fingerprint !== 'string' || a.fingerprint === '') return fail('BAD_ARGS', { message: 'fingerprint must be a string' });
      const continuity = await checkContinuity(bookRoot);
      const finding = continuity.findings.find((f) => f.fingerprint === a.fingerprint);
      if (!finding) return fail('FINDING_NOT_FOUND', { message: 'no current finding has that fingerprint' });
      source = { kind: 'continuity', code: finding.rule, fingerprint: finding.fingerprint };
      const dup = existing.find((t) => t.source.fingerprint === finding.fingerprint && (t.status === 'open' || t.status === 'doing'));
      if (dup) return fail('TASK_EXISTS', { message: 'this finding already has an open task', existing: { id: dup.id, slug: dup.slug, title: dup.title, status: dup.status, path: dup.path } });
      if (title === '') title = finding.title;
      const seen = new Set();
      for (const s of finding.sources) {
        const t = await targetOf(store, byId, s);
        if (t && !seen.has(`${t.id}:${t.line}`)) {
          seen.add(`${t.id}:${t.line}`);
          targets.push(t);
        }
      }
      const evidence = finding.sources.map((s) => `- ${s.file} › ${s.heading}, line ${s.line}${s.excerpt ? `: "${s.excerpt}"` : ''}`);
      notes = [finding.message, '', 'Evidence:', ...evidence, ...(notes.trim() ? ['', notes.trim()] : [])].join('\n');
    } else if (from === 'check') {
      const f = a.finding;
      if (!isMap(f) || typeof f.code !== 'string' || f.code === '' || typeof f.message !== 'string' || typeof a.sceneId !== 'string') return fail('BAD_ARGS', { message: 'expected { sceneId, finding: { code, message, file, line, evidence } }' });
      const scene = byId.get(a.sceneId);
      if (!scene || scene.kind !== 'scene') return fail('NOT_FOUND');
      const line = Number.isInteger(f.line) && f.line >= 1 ? f.line : null;
      const evidence = typeof f.evidence === 'string' ? f.evidence : '';
      const fp = typeof f.fingerprint === 'string' && /^[a-z0-9]{2,4}-[0-9a-f]{16}$/.test(f.fingerprint)
        ? f.fingerprint
        : `chk-${sha(Buffer.from([f.code, scene.fm.id, String(line ?? ''), evidence, f.message].join('\0'))).slice(0, 16)}`;
      source = { kind: 'check', code: f.code, fingerprint: fp };
      const dup = existing.find((t) => t.source.fingerprint === fp && (t.status === 'open' || t.status === 'doing'));
      if (dup) return fail('TASK_EXISTS', { message: 'this finding already has an open task', existing: { id: dup.id, slug: dup.slug, title: dup.title, status: dup.status, path: dup.path } });
      const t = await targetOf(store, byId, { id: scene.fm.id, line, range: null, excerpt: evidence });
      if (t) targets.push(t);
      if (title === '') title = clip(f.message, 120);
      notes = [f.message, ...(evidence ? ['', `Evidence: "${evidence}"`] : []), ...(notes.trim() ? ['', notes.trim()] : [])].join('\n');
    } else {
      if (title === '') return fail('BAD_ARGS', { message: 'a task needs a title' });
      for (const t of a.targets ?? []) {
        if (!isMap(t) || typeof t.id !== 'string') return fail('BAD_ARGS', { message: 'a target needs an id' });
        if (t.line !== undefined && (!Number.isInteger(t.line) || t.line < 1)) return fail('BAD_ARGS', { message: 'line must be a whole number >= 1' });
        if (t.quote !== undefined && (typeof t.quote !== 'string' || t.quote.includes('\n') || t.quote.length > 400)) return fail('BAD_ARGS', { message: 'quote must be one line of text' });
        const doc = byId.get(t.id);
        if (!doc) return fail('BAD_ARGS', { message: `target ${t.id} is not a document of this book` });
        const file = await store.read(doc.rel);
        targets.push({ id: t.id, line: t.line ?? null, quote: t.quote || null, sha256: file ? file.sha256 : null });
      }
    }
    if (title === '') title = 'Revision task';

    const taken = new Set(existing.map((t) => t.slug));
    const base = slugify(title).slice(0, 56).replace(/-+$/g, '') || 'task';
    let slug = base;
    for (let n = 2; ; n++) {
      const busy = taken.has(slug) || (await store.exists(`${TASKS_DIR}/${slug}.md`)) || (await store.exists(`archive/${TASKS_DIR}/${slug}.md`));
      if (!busy) break;
      slug = `${base}-${n}`;
    }
    const file = `${TASKS_DIR}/${slug}.md`;
    const id = `note_${ulid()}`;
    const text = render({ id, slug, title, status: 'open', source, targets, created: isoSecond(new Date(Number(now()))), labels: a.labels ?? [], notes });
    if (a.dryRun === true) return { ok: true, code: 'OK', dryRun: true, file, slug, id, text };

    const known = new Set(found.result.diagnostics.filter((d) => d.severity === 'error').map(errKey));
    const r = await store.batch('createTask', { file, source: source.kind }, (tx) => tx.create(file, Buffer.from(text, 'utf8')), {
      verify: async () => {
        const after = (await validate(root)).diagnostics;
        const fresh = after.filter((d) => d.severity === 'error' && !known.has(errKey(d)));
        if (fresh.length) {
          const err = new Error('the change would introduce new errors');
          /** @type {any} */ (err).diagnostics = fresh;
          throw err;
        }
      },
    });
    if (!r.ok) {
      if (r.code === 'ROLLED_BACK') return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [] });
      if (r.code === 'EXISTS') return fail('REFUSED_PATH_TAKEN', { message: 'a file with that name is already there' });
      return fail(r.code, r.message ? { message: r.message } : {});
    }
    await refresh(found.book);
    return { ok: true, code: 'OK', file, slug, id, opId: r.opId };
  }

  /**
   * Change a task's status: a single-line front-matter edit of that one file. `ref` is the task's id or slug. Refusals: BAD_ARGS, NOT_FOUND, REFUSED_UNSIMPLE_FIELD.
   * @param {string} bookId @param {string} ref @param {string} status
   */
  async function setTaskStatus(bookId, ref, status) {
    if (!TASK_STATUSES.includes(status)) return fail('BAD_ARGS', { message: `status must be one of ${TASK_STATUSES.join(', ')}` });
    const found = await findBook(bookId);
    if (!found || typeof ref !== 'string') return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const task = (await readTasks(store)).find((t) => t.id === ref || t.slug === ref);
    if (!task) return fail('NOT_FOUND');
    const cur = await store.read(task.path);
    if (!cur) return fail('NOT_FOUND');
    const edit = editFrontMatterLine(cur.bytes, 'status', status, { plain: true, anchors: ['title', 'slug', 'id'] });
    if (!edit.ok) return fail(edit.code, { message: edit.message });
    if (edit.changed) {
      const r = await store.write(task.path, edit.buf, { baseSha256: cur.sha256 });
      if (!r.ok) return r.code === 'CONFLICT' ? fail('CONFLICT', { current: null }) : fail(r.code, r.message ? { message: r.message } : {});
      await refresh(found.book);
    }
    const after = await store.read(task.path);
    return { ok: true, code: 'OK', id: task.id, slug: task.slug, status, path: task.path, sha256: after?.sha256 ?? null };
  }

  return { listTasks, getTask, createTask, setTaskStatus };
}
