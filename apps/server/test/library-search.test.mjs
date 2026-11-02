// M02-J02 acceptance 5 (server half): a word that exists only in one book's codex entry finds only that book.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request } from './helpers.mjs';

const WORD = 'zephyrquill';
const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

test('/api/search?q=<planted word> returns only the book whose codex entry holds it', async () => {
  const root = await copyFixture('valid/covers');
  const dir = path.join(root, 'north-road', 'codex', 'characters');
  await fs.writeFile(
    path.join(dir, 'planted.md'),
    [
      '---', 'schema: storyforge.entry/v1', 'id: entry_01V30000000000000000000099', 'slug: planted', 'type: character',
      'name: Planted Person', 'status: canon', '---', `## Overview\nCollects ${WORD} feathers.`, '',
    ].join('\n'),
  );
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const repository = createFsRepository(root);
  await repository.rebuildIndex();
  const server = createServer({ repository, webRoot });
  servers.push(server);
  const port = await listen(server);

  const r = await request(port, 'GET', `/api/search?q=${WORD}&limit=100`);
  assert.equal(r.status, 200);
  const rows = Array.isArray(r.json) ? r.json : r.json?.results ?? r.json?.rows ?? [];
  assert.ok(rows.length >= 1, 'the planted entry is found');
  assert.ok(rows.every((h) => h.path.startsWith('north-road/')), JSON.stringify(rows));
  assert.ok(rows.some((h) => h.kind === 'entry' && h.path.endsWith('planted.md')));

  // a word every book shares still matches every book (the filter is not just "first book")
  const shared = await request(port, 'GET', '/api/search?q=synthetic&limit=100');
  const sharedRows = Array.isArray(shared.json) ? shared.json : shared.json?.results ?? shared.json?.rows ?? [];
  const books = new Set(sharedRows.map((h) => h.path.split('/').slice(0, h.path.startsWith('harbour-lights/') ? 2 : 1).join('/')));
  assert.equal(books.size, 6);
});
