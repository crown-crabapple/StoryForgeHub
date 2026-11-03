// Helpers for the M07-J02 Insights tests (not a test file). The parity check of acceptance 1: the numbers computed from the files, from a fresh index, after every
// `.storyforge/` was deleted and the index rebuilt, and over HTTP are the same bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, listen, request } from './helpers.mjs';

/** Delete every `.storyforge/` folder (and lock file) below `root`, however deep. */
export async function rmStoryforge(root) {
  let n = 0;
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.name === '.storyforge') {
        await fs.rm(full, { recursive: true, force: true });
        n++;
      } else if (e.isDirectory() && e.name !== 'node_modules') await walk(full);
    }
  }
  await walk(root);
  return n;
}

/** A repository with a fixed clock (so "today" is the same in every run) and no watcher. */
export const openRepo = (root, clock) => createFsRepository(root, { watch: false, pollMs: 0, clock });

/** An in-process server over a repository. Returns { port, stop }. */
export async function serve(repo) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const server = createServer({ repository: repo, webRoot });
  const port = await listen(server);
  return { port, stop: () => close(server) };
}

/**
 * The four ways of taking one book's insights, which must agree to the byte.
 * @param {string} root a library or book root @param {() => number} clock
 * @param {{ ids?: string[] }} [opts] books to check (default: every book)
 * @returns {Promise<Map<string, string>>} book id -> the JSON text
 */
export async function insightsParity(root, clock, { ids } = {}) {
  const jsonOf = (r) => {
    assert.equal(r.ok, true, JSON.stringify(r));
    return JSON.stringify(r.insights);
  };
  const first = openRepo(root, clock);
  let expected;
  try {
    const books = ids ?? (await first.listBooks()).map((b) => b.id);
    await first.ensureIndexes();
    expected = new Map();
    for (const id of books) expected.set(id, jsonOf(await first.getInsights(id, { from: 'files' })));

    // from a fresh index (after a rebuild)
    await first.rebuildIndex();
    for (const id of books) {
      const r = await first.getInsights(id);
      assert.equal(r.source, 'index', 'the fresh index answers');
      assert.equal(jsonOf(r), expected.get(id), `index == files for ${id}`);
    }
  } finally {
    await first.close();
  }

  // every .storyforge/ gone: from the files, then after a rebuild, then over HTTP
  const removed = await rmStoryforge(root);
  assert.ok(removed > 0, 'there was an index to delete');
  const second = openRepo(root, clock);
  const web = await serve(second);
  try {
    for (const id of expected.keys()) assert.equal(jsonOf(await second.getInsights(id, { from: 'files' })), expected.get(id), `files after delete for ${id}`);
    await second.rebuildIndex();
    for (const id of expected.keys()) {
      const r = await second.getInsights(id);
      assert.equal(r.source, 'index');
      assert.equal(jsonOf(r), expected.get(id), `rebuild == before for ${id}`);
      const http = await request(web.port, 'GET', `/api/books/${id}/insights`);
      assert.equal(http.status, 200);
      assert.equal(http.text, expected.get(id), `HTTP body is the same bytes for ${id}`);
    }
  } finally {
    await web.stop();
    await second.close();
  }
  return expected;
}
