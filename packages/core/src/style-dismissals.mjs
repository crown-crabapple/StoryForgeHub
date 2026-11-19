// Style dismissals (M13-J03): create / archive / list `planning/style/<slug>.md`, one Markdown file per dismissed style finding (copying continuity exceptions, M05-J02).
// Everything is written through @storyforge/store (atomic, journaled, a trash copy for Undo). Prose is never touched. The front matter is serialised with the yaml library,
// never by joining the author's text into a string.
import path from 'node:path';
import { STYLE_RULE_IDS, extractDocs, validate } from '@storyforge/format';
import { slugify, ulid } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';
import YAML from 'yaml';
import { localDate } from './writing-log.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const DIR = 'planning/style';
const KIND = 'style-dismissal';
const FINGERPRINT_RE = /^sty-[0-9a-f]{16}$/;
const SCENE_ID_RE = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TEXT = 500;
const MAX_NOTE = 2000;
const errKey = (d) => `${d.code}|${d.file}|${d.location ?? ''}`;

/**
 * @param {{ root: string, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>, now?: () => number }} p
 */
export function createStyleDismissalMethods({ root, afterWrite = () => {}, reconcile, now = () => Date.now() }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result } : null;
  }

  /** Run one batch (create or archive); the store undoes it if the library gained a validation error. */
  async function run(found, store, op, args, fn) {
    const { book, result } = found;
    const known = new Set(result.diagnostics.filter((d) => d.severity === 'error').map(errKey));
    const r = await store.batch(op, args, fn, {
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
    if (r.ok) {
      if (reconcile) await reconcile(book.path);
      else afterWrite(book.path);
      return r;
    }
    if (r.code === 'ROLLED_BACK') return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [] });
    if (r.code === 'EXISTS') return fail('REFUSED_PATH_TAKEN', { message: 'a file with that name is already there' });
    return fail(r.code, r.message ? { message: r.message } : {});
  }

  /**
   * Dismiss one style finding: write planning/style/<slug>.md. Refusals write nothing: BAD_ARGS, ALREADY_DISMISSED (a live dismissal has that fingerprint), NOT_FOUND (no such book),
   * ROLLED_BACK (the library would gain a validation error). Undo = restoreOp(opId).
   * @param {string} bookId @param {{ fingerprint?: string, rule?: string, sceneId?: string, text?: string, note?: string|null }} args
   */
  async function createStyleDismissal(bookId, args = {}) {
    const { fingerprint, rule, sceneId, text, note } = args ?? {};
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return fail('BAD_ARGS', { message: 'fingerprint must look like sty-0123456789abcdef' });
    if (typeof rule !== 'string' || !STYLE_RULE_IDS.includes(rule)) return fail('BAD_ARGS', { message: `rule must be one of ${STYLE_RULE_IDS.join(', ')}` });
    if (typeof sceneId !== 'string' || !SCENE_ID_RE.test(sceneId)) return fail('BAD_ARGS', { message: 'sceneId must be scene_ plus a 26-character ULID' });
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) return fail('BAD_ARGS', { message: `text must be the flagged passage (1 to ${MAX_TEXT} characters)` });
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) return fail('BAD_ARGS', { message: `note must be text of at most ${MAX_NOTE} characters` });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const docs = extractDocs(found.result, found.book.path).filter((d) => d.kind === KIND);
    if (docs.some((d) => !d.archived && d.fm.fingerprint === fingerprint)) return fail('ALREADY_DISMISSED', { message: 'this finding is already dismissed' });
    const store = await openStore(bookRootOf(found.book));
    const taken = new Set(docs.map((d) => String(d.fm.slug ?? '')));
    const base = slugify(`${rule} ${text}`).slice(0, 56).replace(/-+$/g, '') || rule;
    let slug = base;
    for (let n = 2; ; n++) {
      const busy = taken.has(slug) || (await store.exists(`${DIR}/${slug}.md`)) || (await store.exists(`archive/${DIR}/${slug}.md`));
      if (!busy) break;
      slug = `${base}-${n}`;
    }
    const file = `${DIR}/${slug}.md`;
    const id = `note_${ulid()}`;
    const fm = YAML.stringify({ schema: 'storyforge.style-dismissal/v1', id, slug, fingerprint, rule, scene: sceneId, text, created: localDate(new Date(Number(now()))) }, { lineWidth: 0 });
    const body = typeof note === 'string' && note.trim() !== '' ? `${note.trim()}\n` : '';
    const bytes = Buffer.from(`---\n${fm}---\n${body}`, 'utf8');
    const r = await run(found, store, 'createStyleDismissal', { fingerprint, file }, (tx) => tx.create(file, bytes));
    if (!r.ok) return r;
    // Undo = restoreOp(opId): for this one operation it removes the new file again (to the trash), leaving the tree as it was.
    return { ok: true, code: 'OK', file, slug, id, opId: r.opId, undo: { op: r.opId } };
  }

  /**
   * Restore a dismissed finding: archive its file (never a hard delete). `slug` is the dismissal's front-matter slug. Missing: NOT_FOUND.
   * @param {string} bookId @param {string} slug
   */
  async function archiveStyleDismissal(bookId, slug) {
    const found = await findBook(bookId);
    if (!found || typeof slug !== 'string' || slug === '') return fail('NOT_FOUND');
    const doc = extractDocs(found.result, found.book.path).find((d) => d.kind === KIND && !d.archived && d.fm.slug === slug);
    if (!doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book));
    const cur = await store.read(doc.rel);
    if (!cur) return fail('NOT_FOUND');
    const archived = `archive/${doc.rel}`;
    const r = await run(found, store, 'archiveStyleDismissal', { slug, file: doc.rel }, (tx) => tx.archive(doc.rel, { baseSha256: cur.sha256 }));
    if (!r.ok) return r;
    return { ok: true, code: 'OK', archived, slug, opId: r.opId, undo: { op: r.opId } };
  }

  /**
   * The live dismissals of a book, in file order. An unknown book has none.
   * @param {string} bookId
   * @returns {Promise<{ slug: string, fingerprint: string, rule: string, sceneId: string, text: string, note: string, created: string }[]>}
   */
  async function listStyleDismissals(bookId) {
    const found = await findBook(bookId);
    if (!found) return [];
    return extractDocs(found.result, found.book.path)
      .filter((d) => d.kind === KIND && !d.archived && typeof d.fm.slug === 'string' && typeof d.fm.fingerprint === 'string')
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      .map((d) => ({
        slug: d.fm.slug,
        fingerprint: d.fm.fingerprint,
        rule: String(d.fm.rule ?? ''),
        sceneId: String(d.fm.scene ?? ''),
        text: String(d.fm.text ?? ''),
        note: String(d.body ?? '').trim(),
        created: d.fm.created instanceof Date ? d.fm.created.toISOString().slice(0, 10) : String(d.fm.created ?? ''),
      }));
  }

  return { createStyleDismissal, archiveStyleDismissal, listStyleDismissals };
}
