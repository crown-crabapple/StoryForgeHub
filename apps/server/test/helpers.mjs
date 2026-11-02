import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../../packages/format/fixtures');
export const REPO_ROOT = path.resolve(here, '../../..');

/** Copy a fixture (e.g. 'valid/salt-orchard') into a fresh temp dir; returns its path. */
export async function copyFixture(rel) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-srv-'));
  const dest = path.join(base, path.basename(rel));
  await fs.cp(path.join(FIXTURES, rel), dest, { recursive: true });
  return dest;
}

export async function readExpected(rel) {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, rel, 'expected.json'), 'utf8'));
}

/** sha256 of every file (and directory name) under root, keyed by relative path. */
export async function snapshot(root, { skipStoryforge = false } = {}) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (skipStoryforge && e.name === '.storyforge') continue;
      // M05-J07: provenance/ (receipts and objects) is the intended new effect of AI, suggestion and adapter actions; the receipts-*.test.mjs files check it directly.
      if (dir === root && e.name === 'provenance') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        out[rel + '/'] = 'dir';
        await walk(full);
      } else {
        out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Listen on port 0 (loopback). Tolerates createServer returning either a node http.Server
 * (not yet listening) or one that is already listening.
 */
export async function listen(server) {
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  return server.address().port;
}

export async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Raw HTTP request (global fetch cannot set Host and normalises dot segments).
 * `host` overrides the Host header; `pathname` is sent verbatim.
 */
export function request(port, method, pathname, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { Host: host ?? `127.0.0.1:${port}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
