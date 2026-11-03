// M08-J02 acceptance 6 (FORMAT-v1 3.8): the plugin manifest kind (E102, permissions[i], W315), the scanner skipping _plugins/, and the optional
// `plugin` on a suggestion with source plugin. Each case edits a temp copy of valid/library and compares with the untouched copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODULE_IDS, PLUGIN_API_MAJOR, discover, loadPlugins, parsePluginManifest, validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copy(name = 'library') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-j02-'));
  const dest = path.join(base, name);
  fs.cpSync(path.join(VALID, name), dest, { recursive: true });
  return dest;
}
const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
const put = (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
async function added(edit, name) {
  const root = copy(name);
  const base = keys(await validate(root));
  await edit(root);
  return keys(await validate(root)).filter((k) => !base.includes(k));
}

const manifest = (over = {}) => {
  const fm = { schema: 'storyforge.plugin/v1', id: 'note_01S8000000000000000000WF01', plugin: 'word-frequency', name: 'Word frequency', version: '1.2.0', api: 1, permissions: '[read]', books: 'all', homepage: '""', ...over };
  return `---\n${Object.entries(fm).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\nWhat it does, in plain words.\n`;
};
const PATH = '_plugins/word-frequency/plugin.md';

test('a well-formed manifest is valid and adds no diagnostic', async () => {
  assert.deepEqual(await added((root) => put(root, PATH, manifest())), []);
  assert.deepEqual(await added((root) => put(root, PATH, manifest({ permissions: '[read, propose, events]', books: '[lantern-hill, tidewater]' }))), []);
  const r = parsePluginManifest(manifest());
  assert.equal(r.ok, true);
  assert.deepEqual(r.item.permissions, ['read']);
  assert.equal(r.item.books, 'all');
  assert.equal(r.item.description, 'What it does, in plain words.');
});

test('E102: every bad shape names its field', async () => {
  const cases = [
    [{ schema: 'storyforge.plugin/v2' }, 'schema'],
    [{ id: 'plugin_1' }, 'id'],
    [{ plugin: 'Word Frequency' }, 'plugin'],
    [{ name: '""' }, 'name'],
    [{ version: 'one' }, 'version'],
    [{ api: 'one' }, 'api'],
    [{ api: 0 }, 'api'],
    [{ permissions: '[]' }, 'permissions'],
    [{ permissions: 'read' }, 'permissions'],
    [{ books: '[]' }, 'books'],
    [{ books: 'some' }, 'books'],
    [{ books: '[Not A Slug]' }, 'books[0]'],
    [{ homepage: '[a]' }, 'homepage'],
  ];
  for (const [over, loc] of cases) {
    assert.deepEqual(await added((root) => put(root, PATH, manifest(over))), [`E102 | ${PATH} | ${loc}`], JSON.stringify(over));
  }
});

test('E102 at permissions[i]: an unknown permission, whichever position', async () => {
  assert.deepEqual(await added((root) => put(root, PATH, manifest({ permissions: '[read, write]' }))), [`E102 | ${PATH} | permissions[1]`]);
  assert.deepEqual(await added((root) => put(root, PATH, manifest({ permissions: '[admin, read, delete]' }))), [`E102 | ${PATH} | permissions[0]`, `E102 | ${PATH} | permissions[2]`]);
});

test('W315: an api newer than this StoryForge serves is a warning, not an error', async () => {
  assert.equal(PLUGIN_API_MAJOR, 1);
  assert.deepEqual(await added((root) => put(root, PATH, manifest({ api: 2 }))), [`W315 | ${PATH} | api`]);
  const r = await validate(copy());
  const root = copy();
  put(root, PATH, manifest({ api: 7 }));
  const d = (await validate(root)).diagnostics.find((x) => x.code === 'W315');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /newer StoryForge/);
  assert.equal((await validate(root)).diagnostics.filter((x) => x.severity === 'error').length, r.diagnostics.filter((x) => x.severity === 'error').length, 'no new error');
  assert.equal(parsePluginManifest(manifest({ api: 2 })).ok, true, 'the manifest itself is usable; it only says it needs more');
});

test('E102: a plugin folder without plugin.md, a duplicate plugin slug, a file that is not front matter', async () => {
  assert.deepEqual(await added((root) => fs.mkdirSync(path.join(root, '_plugins', 'empty'), { recursive: true })), ['E102 | _plugins/empty/plugin.md | ']);
  assert.deepEqual(
    await added((root) => {
      put(root, '_plugins/a/plugin.md', manifest());
      put(root, '_plugins/b/plugin.md', manifest({ id: 'note_01S8000000000000000000WF02' }));
    }),
    ['E102 | _plugins/b/plugin.md | plugin'],
  );
  const got = await added((root) => put(root, PATH, 'no front matter here\n'));
  assert.ok(got.length >= 1, 'a file without front matter is reported');
  for (const k of got) assert.match(k, /^E\d+ \| _plugins\/word-frequency\/plugin\.md/);
});

test('the scanner skips _plugins/: its folders are never books or series, with or without a book.md inside', async () => {
  const root = copy();
  const before = (await validate(root)).books.map((b) => b.path);
  put(root, PATH, manifest());
  put(root, '_plugins/sneaky/book.md', '---\nschema: storyforge.book/v1\nid: book_01S8000000000000000000WF99\nslug: sneaky\ntitle: Sneaky\nprofile: fiction\nstatus: drafting\n---\n');
  put(root, '_plugins/sneaky/plugin.md', manifest({ plugin: 'sneaky', id: 'note_01S8000000000000000000WF05' }));
  const found = await discover(root, 'library', () => {});
  assert.deepEqual(found.books.map((b) => b.path).sort(), before.slice().sort());
  assert.deepEqual((await validate(root)).books.map((b) => b.path), before);
  assert.ok(found.series.every((s) => !s.startsWith('_plugins')));
});

test('loadPlugins lists manifests with their problems and never throws', async () => {
  const root = copy();
  assert.deepEqual(await loadPlugins(root), { plugins: [], diagnostics: [] });
  put(root, '_plugins/ok/plugin.md', manifest());
  put(root, '_plugins/bad/plugin.md', manifest({ plugin: 'bad-one', id: 'note_01S8000000000000000000WF03', permissions: '[read, nope]' }));
  put(root, '_plugins/newer/plugin.md', manifest({ plugin: 'newer', id: 'note_01S8000000000000000000WF04', api: 3 }));
  const { plugins } = await loadPlugins(root);
  const by = Object.fromEntries(plugins.map((p) => [p.plugin, p.problems.map((x) => `${x.code} ${x.location}`)]));
  assert.deepEqual(by, { 'bad-one': ['E102 permissions[1]'], newer: ['W315 api'], 'word-frequency': [] });
});

test('a suggestion may have source plugin and a plugin slug; a plugin that is not a slug is E102', async () => {
  const SUGGESTION = 'suggestions/2026/20261102-150000-eyes.md';
  const text = (extra = 'plugin: word-frequency\n', source = 'plugin') => `---
schema: storyforge.suggestion/v1
id: note_01S50000000000000000000S01
target: scene_01S50000000000000000000002
target_path: manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md
base_sha256: ""
source: ${source}
mode: suggest
created: "2026-11-02T15:00:00Z"
by: { name: "Word frequency" }
${extra}status: pending
hunks:
  - { id: h1, line: 1, lines: 1, original_sha256: "", status: pending }
---
\`\`\`diff
@@ -1,1 +1,1 @@ h1
-a
+b
\`\`\`
`;
  const withEdit = async (body) => (await added((root) => put(root, SUGGESTION, body), 'salt-orchard')).filter((k) => !k.startsWith('W308') && !k.startsWith('E102 | ' + SUGGESTION + ' | hunks'));
  assert.deepEqual(await withEdit(text()), []);
  assert.deepEqual(await withEdit(text('plugin: Not A Slug\n')), [`E102 | ${SUGGESTION} | plugin`]);
  assert.deepEqual(await withEdit(text('', 'robot')), [`E102 | ${SUGGESTION} | source`]);
});

test('the integrations module is a module id, last in the list', () => {
  assert.equal(MODULE_IDS.at(-1), 'integrations');
});
