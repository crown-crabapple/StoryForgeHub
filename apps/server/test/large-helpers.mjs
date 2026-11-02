// Helpers for the M06-J03 real-sized recovery tests (not a test file). Contract: docs/contracts/M06-J03-recovery-a11y-packaging.md section 1.
// The book comes from packages/format/test/build-large.mjs (3 acts, 60 chapters, 320 scenes, ~130 000 words, 220 entries, ...).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLargeBook } from '../../../packages/format/test/build-large.mjs';
import { makeHome, startApp, stopAll } from './ai-helpers.mjs';
import { waitFor } from './proc-helpers.mjs';

export { makeHome, startApp, stopAll, waitFor };

let built = null;
/** Build the large book once per process (into a temp dir) and return { root, stats, bookId, scenes, entries }. */
export function largeBook() {
  if (!built) {
    const dir = path.join(os.tmpdir(), `sf-large-${process.pid}-${Date.now()}`, 'large-book');
    built = buildLargeBook(dir);
  }
  return built;
}

/** A fresh copy of the large book in its own temp dir (the original stays pristine). */
export async function copyLarge() {
  const src = largeBook().root;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-large-copy-'));
  const dest = path.join(base, 'large-book');
  await fs.cp(src, dest, { recursive: true });
  return dest;
}

/** Every file under `root` as relative path -> Buffer, leaving out the disposable cache and the instance lock (and, with `skip`, other top-level names). */
export async function readTree(root, { skip = [] } = {}) {
  const out = new Map();
  async function walk(dir, rel) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!rel && (e.name === '.storyforge' || e.name === '.storyforge-lock' || skip.includes(e.name))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else out.set(r, await fs.readFile(path.join(dir, e.name)));
    }
  }
  await walk(root, '');
  return out;
}

export const sameBytes = (a, b) => a.length === b.length && a.equals(b);

/** Poll (never a blind sleep) until every book's index is fresh; resolves with the elapsed ms since `since`. */
export async function waitIndexFresh(app, since = Date.now(), timeout = 60000) {
  await waitFor(
    async () => {
      const r = await app.get('/api/index/status');
      return r.status === 200 && Array.isArray(r.json) && r.json.length > 0 && r.json.every((s) => s.state === 'fresh');
    },
    { timeout, interval: 100, what: 'every index fresh' },
  );
  return Date.now() - since;
}

/** Start the app on `root` with a private user config dir. Returns { app, home, startedAt }. */
export async function startLarge(root, home = null) {
  const h = home ?? (await makeHome());
  const startedAt = Date.now();
  const app = await startApp({ library: root, home: h });
  return { app, home: h, startedAt };
}

/** Get JSON or throw with the body. */
export async function getJson(app, url) {
  const r = await app.get(url);
  if (r.status !== 200) throw new Error(`GET ${url} -> ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * Every answer the app gives about the book, keyed by what was asked: the book tree, every scene, every Codex entry, the Codex lists, threads,
 * timeline, notes, scene notes, continuity, suggestions, objects, graph, diagnostics and the receipts check. Compared as JSON.
 */
export async function collectAnswers(app, bookId) {
  const b = `/api/books/${bookId}`;
  const tree = await getJson(app, b);
  const allScenes = tree.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).map((s) => s.id);
  // one GET of a scene or an entry costs about 0.7 s on this book (the server loads the book for each), so every 10th scene and every 11th entry is read in full;
  // the book tree, the entry list, the graph, the timeline, the threads and the rest cover all of them in one answer each
  const sceneIds = allScenes.filter((_, i) => i % 10 === 0);
  const entries = await getJson(app, `${b}/codex/entries`);
  const entryIds = (Array.isArray(entries) ? entries : entries.entries ?? []).map((e) => e.id).filter((_, i) => i % 11 === 0);
  const answers = { tree, entries };
  for (const k of ['codex/types', 'threads', 'timeline', 'notes', 'scene-notes', 'continuity', 'suggestions', 'objects', 'graph', 'diagnostics', 'receipts/verify']) answers[k] = await getJson(app, `${b}/${k}`);
  const scenes = await mapLimit(sceneIds, 8, (id) => getJson(app, `${b}/scenes/${id}`));
  sceneIds.forEach((id, i) => (answers[`scene ${id}`] = scenes[i]));
  const full = await mapLimit(entryIds, 8, (id) => getJson(app, `${b}/entries/${id}`));
  entryIds.forEach((id, i) => (answers[`entry ${id}`] = full[i]));
  return { answers, sceneIds, entryIds, sceneCount: allScenes.length };
}

/** The first answer that differs between two collections (key and a short excerpt of each), or null when they are equal. `ignore`: key names left out (a file's modified time). */
export function firstDifference(a, b, { ignore = [] } = {}) {
  const replacer = (k, v) => (ignore.includes(k) ? undefined : v);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = JSON.stringify(a[k], replacer);
    const y = JSON.stringify(b[k], replacer);
    if (x !== y) {
      let i = 0;
      while (i < x.length && x[i] === y?.[i]) i++;
      return `${k}: first difference at char ${i}: ${x.slice(Math.max(0, i - 40), i + 80)}  <->  ${y?.slice(Math.max(0, i - 40), i + 80)}`;
    }
  }
  return null;
}

/** Print a timing line the gate can quote ("# LARGE-TIMING <name> <ms> ms (budget <ms>)"). */
export function reportTime(name, ms, budget) {
  console.log(`# LARGE-TIMING ${name}: ${ms} ms${budget ? ` (budget ${budget} ms)` : ''}`);
}
