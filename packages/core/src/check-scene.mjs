// "Check my scene" (M05-J06 section 2): a read-only report on one scene. The validator's diagnostics for the scene file and the files it links, plus the
// continuity findings that quote the scene. No model call and no write; the only side effect is the provenance event (its receipt, M05-J07).
import path from 'node:path';
import { checkContinuity } from '@storyforge/continuity';
import { extractDocs, extractLinks, validate } from '@storyforge/format';
import { openStore } from '@storyforge/store';
import { recordProvenance } from './provenance.mjs';
import { createReceiptEngine } from './receipts.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const RANK = { error: 0, warning: 1, info: 2 };
const clip = (s) => (s.length <= 160 ? s : `${s.slice(0, 159)}…`);

/**
 * @param {{ root: string, now?: () => number | Date, receipts?: ReturnType<typeof createReceiptEngine> }} p
 */
export function createCheckMethods({ root, now = () => Date.now(), receipts = createReceiptEngine({ root, now }) }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));

  /**
   * The check report for a live scene: `{ scene, at, findings, summary }`. Refusals: NOT_FOUND.
   * @param {string} bookId @param {string} sceneId
   */
  async function checkScene(bookId, sceneId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book || typeof sceneId !== 'string') return fail('NOT_FOUND');
    const prefix = book.path === '' ? '' : `${book.path}/`;
    const docs = extractDocs(result, book.path);
    const scene = docs.find((d) => d.kind === 'scene' && !d.archived && d.fm.id === sceneId);
    if (!scene) return fail('NOT_FOUND');
    const bookRel = (file) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file);

    const store = await openStore(bookRootOf(book), { recover: false });
    /** @type {Map<string, string[] | null>} */
    const texts = new Map();
    const lineOf = async (rel, n) => {
      if (!texts.has(rel)) {
        const got = await store.read(rel);
        texts.set(rel, got ? got.bytes.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')) : null);
      }
      const lines = texts.get(rel);
      return lines && n >= 1 && n <= lines.length ? lines[n - 1] : '';
    };

    // (a) validator diagnostics for the scene and the files it links
    const byId = new Map(docs.filter((d) => typeof d.fm.id === 'string').map((d) => [d.fm.id, d]));
    const files = new Set([scene.rel]);
    for (const l of extractLinks(result, book.path)) {
      if (l.src_id !== sceneId || !l.target_id) continue;
      const t = byId.get(l.target_id);
      if (t) files.add(t.rel);
    }
    const findings = [];
    for (const d of result.diagnostics) {
      const rel = bookRel(d.file);
      if (!files.has(rel) || (prefix && !d.file.startsWith(prefix))) continue;
      const m = /^line (\d+)/.exec(d.location ?? '');
      const line = m ? Number(m[1]) : null;
      const evidence = line !== null ? clip((await lineOf(rel, line)).trim()) : String(d.location ?? '');
      findings.push({ severity: d.severity, kind: 'diagnostic', code: d.code, file: rel, line, range: null, evidence, message: d.message });
    }

    // (b) continuity findings whose sources include the scene
    const continuity = await checkContinuity(bookRootOf(book));
    for (const f of continuity.findings) {
      const src = f.sources.find((s) => s.id === sceneId);
      if (!src) continue;
      findings.push({ severity: f.severity, kind: 'continuity', code: f.rule, file: src.file, line: src.line, range: src.range, evidence: src.excerpt, message: f.message, fingerprint: f.fingerprint });
    }

    findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const count = (s) => findings.filter((f) => f.severity === s).length;
    const summary = {
      total: findings.length,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      diagnostics: findings.filter((f) => f.kind === 'diagnostic').length,
      continuity: findings.filter((f) => f.kind === 'continuity').length,
    };
    const report = { ok: true, code: 'OK', scene: { id: sceneId, title: String(scene.fm.title ?? ''), path: scene.rel }, at: new Date(Number(now())).toISOString(), findings, summary };
    try {
      await recordProvenance({ kind: 'check.report', bookId, sceneId, scene: scene.rel, at: report.at, summary }, { engine: receipts, bookRoot: bookRootOf(book) });
    } catch {
      // the hook is advisory
    }
    return report;
  }

  return { checkScene };
}
