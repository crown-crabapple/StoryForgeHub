import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const dist = join(webDir, 'dist');

// XML namespace identifiers (never fetched) and React's production error-message text (a string in the
// bundle that is shown to the developer, never requested).
const ALLOWED = [/^http:\/\/www\.w3\.org\//, /^https:\/\/react\.dev\/errors\/?$/];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

async function ensureBuilt() {
  if (existsSync(join(dist, 'index.html'))) return;
  await build({ root: webDir, logLevel: 'silent' });
}

test('the built app contains no external URLs (fonts are self-hosted)', async () => {
  await ensureBuilt();
  const found = [];
  for (const file of files(dist)) {
    if (/\.(woff2?|ttf|otf|png|jpe?g|gif|ico|webp)$/i.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
      if (!ALLOWED.some((re) => re.test(m[0]))) found.push(`${file.slice(dist.length + 1)}: ${m[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the built index.html loads only its own files', async () => {
  await ensureBuilt();
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|preconnect/);
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(m[1], /^\//, `not a same-origin path: ${m[1]}`);
});

test('the font faces are bundled: served from the app, not a CDN', async () => {
  await ensureBuilt();
  const css = files(join(dist, 'assets'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  assert.match(css, /Inter Variable/);
  assert.match(css, /Literata Variable/);
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) assert.doesNotMatch(m[1], /^["']?https?:/, m[1]);
});
