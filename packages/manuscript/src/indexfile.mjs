// The disposable index: .storyforge/index.json. Written by rebuildIndex, read only by readIndex.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadBook } from './book.mjs';
import { atomicWrite } from './commit.mjs';
import { sha256 } from './util.mjs';

const indexPath = (root) => path.join(root, '.storyforge', 'index.json');

/** @param {string} bookRoot */
export async function rebuildIndex(bookRoot) {
  try {
    const lb = await loadBook(bookRoot);
    if ('error' in lb) return { ok: false, code: lb.error.code, changes: [], message: lb.error.message };
    const scenes = [];
    for (const s of lb.book.order) {
      const buf = await readFile(path.join(lb.root, ...s.path.split('/')));
      scenes.push({ position: s.position, id: s.id, act: s.act, chapter: s.chapter, sequence: s.sequence, path: s.path, sha256: sha256(buf) });
    }
    const index = { schema: 'storyforge.index/v1', built_at: new Date().toISOString(), scenes };
    await atomicWrite(indexPath(lb.root), Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
    return { ok: true, code: 'OK', changes: [], index };
  } catch (e) {
    return { ok: false, code: 'ERROR', changes: [], message: String(e?.message ?? e) };
  }
}

/** Parsed index, or null if missing or corrupt. Never used for ordering. */
export async function readIndex(bookRoot) {
  try {
    const data = JSON.parse(await readFile(indexPath(path.resolve(bookRoot)), 'utf8'));
    if (data && data.schema === 'storyforge.index/v1' && Array.isArray(data.scenes)) return data;
    return null;
  } catch {
    return null;
  }
}
