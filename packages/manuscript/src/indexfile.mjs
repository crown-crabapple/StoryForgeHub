// The disposable index: .storyforge/index.json. Written by rebuildIndex, read only by readIndex.
import path from 'node:path';
import { openStore } from '@storyforge/store';
import { loadBook } from './book.mjs';
import { sha256 } from './util.mjs';

/** @param {string} bookRoot */
export async function rebuildIndex(bookRoot) {
  try {
    const store = typeof bookRoot === 'string' && bookRoot !== '' ? await openStore(path.resolve(bookRoot)) : null;
    const lb = await loadBook(bookRoot);
    if ('error' in lb) return { ok: false, code: lb.error.code, changes: [], message: lb.error.message };
    const scenes = [];
    for (const s of lb.book.order) {
      const read = await store.read(s.path);
      if (!read) throw new Error(`cannot read ${s.path}`);
      scenes.push({ position: s.position, id: s.id, act: s.act, chapter: s.chapter, sequence: s.sequence, path: s.path, sha256: sha256(read.bytes) });
    }
    const index = { schema: 'storyforge.index/v1', built_at: new Date().toISOString(), scenes };
    const w = await store.writeMeta('index.json', Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
    if (!w.ok) throw new Error(`cannot write index (${w.code})`);
    return { ok: true, code: 'OK', changes: [], index };
  } catch (e) {
    return { ok: false, code: 'ERROR', changes: [], message: String(e?.message ?? e) };
  }
}

/** Parsed index, or null if missing or corrupt. Never used for ordering. */
export async function readIndex(bookRoot) {
  try {
    const store = await openStore(path.resolve(bookRoot), { recover: false });
    const bytes = await store.readMeta('index.json');
    const data = bytes ? JSON.parse(bytes.toString('utf8')) : null;
    if (data && data.schema === 'storyforge.index/v1' && Array.isArray(data.scenes)) return data;
    return null;
  } catch {
    return null;
  }
}
