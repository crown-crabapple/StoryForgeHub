// M07-J04 acceptance: profiles and preference layers (1, 2), modules (4) and custom prompts (5), against real server processes.
// Contract: docs/contracts/M07-J04-customization-modules.md. (3, shortcut coverage, and 6, contrast and the keyboard walk, are in apps/web/test.)
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cssVariables } from '../../web/src/prefs/appearance.js';
import { snapshot } from './helpers.mjs';
import { startMockProvider, setupProvider, send } from './ai-helpers.mjs';
import { BOOK, ID_B, KEY_SCENE, MAREN, SCENE, freshBook, listFiles, makeHome, projectLibrary, promptFile, readFile, runMain, setBookPreferences, start, stopAll, workflowFile, writePrompt } from './custom-helpers.mjs';

after(stopAll);

const bookUrl = (p = '') => `/api/books/${BOOK}${p}`;
const sceneOrder = (book) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
/** Every file outside .storyforge/ (hashes), with provenance/ included. The instance lock file is left out: it is the server's, and a killed server leaves it behind. */
async function everything(root) {
  const snap = await snapshot(root, { skipStoryforge: true });
  delete snap['.storyforge-lock'];
  return { snap, files: (await listFiles(root)).filter((f) => f !== '.storyforge-lock') };
}

// ---------------------------------------------------------------- acceptance 1: two profiles, one project

describe('two profiles, one project', () => {
  test('profile A and profile B on the same library in two server runs: the files and the manuscript order are identical, the variables differ as configured', async () => {
    const library = await projectLibrary(); // library.md and book.md must stay byte for byte
    const home = await makeHome();
    const before = await everything(library);

    // --- run 1: --profile a: light, sans 18, Planning, Ctrl+Shift+K rebound
    const a = await start({ library, home, args: ['--profile', 'a'] });
    const saveA = await a.put('/api/profile', { theme: 'light', typography: { family: 'sans', size: 18 }, layout: { name: 'Planning' }, shortcuts: { 'focus.toggle': 'Ctrl+Shift+K' } });
    assert.equal(saveA.status, 200, saveA.text);
    const prefsA = (await a.get(`/api/preferences?book=${BOOK}`)).json;
    const orderA = sceneOrder((await a.get(bookUrl())).json);
    await a.stop();
    const between = await everything(library);

    // --- run 2: STORYFORGE_PROFILE=b: dark, serif, Writing, defaults
    const b = await start({ library, home, env: { STORYFORGE_PROFILE: 'b' } });
    const saveB = await b.put('/api/profile', { theme: 'dark', typography: { family: 'serif' }, layout: { name: 'Writing' } });
    assert.equal(saveB.status, 200, saveB.text);
    const prefsB = (await b.get(`/api/preferences?book=${BOOK}`)).json;
    const orderB = sceneOrder((await b.get(bookUrl())).json);
    await b.stop();
    const after = await everything(library);

    // nothing in the library changed by choosing or saving a profile (library.md and book.md included)
    assert.deepEqual(between, before);
    assert.deepEqual(after, before);
    assert.ok(before.snap['library.md'] && before.snap['salt-orchard/book.md']);
    // the manuscript is the same under both
    assert.deepEqual(orderA, orderB);
    assert.ok(orderA.length >= 7, `scenes: ${orderA.length}`);

    // each run used its own profile
    assert.equal(prefsA.profile.name, 'a');
    assert.equal(prefsB.profile.name, 'b');
    assert.equal(prefsA.effective.theme, 'light');
    assert.equal(prefsB.effective.theme, 'dark');
    assert.equal(prefsA.effective.typography.family, 'sans');
    assert.equal(prefsA.effective.typography.size, 18);
    assert.equal(prefsB.effective.typography.family, 'serif');
    assert.equal(prefsA.effective.layout.name, 'Planning');
    assert.equal(prefsB.effective.layout.name, 'Writing');
    assert.equal(prefsA.effective.shortcuts['focus.toggle'], 'Ctrl+Shift+K');
    assert.deepEqual(prefsB.effective.shortcuts, {});
    assert.equal(prefsA.sources.theme, 'profile');

    // the rendered CSS variables differ as configured
    const varsA = cssVariables(prefsA.effective, { customThemes: prefsA.profile.customThemes, layouts: prefsA.profile.layouts });
    const varsB = cssVariables(prefsB.effective, { customThemes: prefsB.profile.customThemes, layouts: prefsB.profile.layouts });
    assert.equal(varsA['--bg'], '#F6F5F1');
    assert.equal(varsB['--bg'], undefined, 'the dark reference is tokens.css itself');
    assert.match(varsA['--font-prose'], /^system-ui/);
    assert.match(varsB['--font-prose'], /Literata/);
    assert.equal(varsA['--rail'], '320px');
    assert.equal(varsB['--rail'], '260px');
    assert.equal(varsA['--fs-prose'], '18px');
    assert.notDeepEqual(varsA, varsB);

    // the profiles are files in the user config folder, not in the library
    const profileFiles = (await fs.readdir(path.join(home.configDir, 'profiles'))).sort();
    assert.deepEqual(profileFiles, ['a.json', 'b.json']);
    assert.equal(JSON.parse(await fs.readFile(path.join(home.configDir, 'profiles', 'a.json'), 'utf8')).theme, 'light');

    // a later run with --profile a finds A's choices again (they are kept per profile, per machine)
    const again = await start({ library, home, args: ['--profile=a'] });
    assert.equal((await again.get(`/api/preferences?book=${BOOK}`)).json.effective.theme, 'light');
    await again.stop();
    assert.deepEqual(await everything(library), before);
  });

  test('--profile beats STORYFORGE_PROFILE; the default name is "default"; a bad name is refused (exit 2)', async () => {
    const library = await freshBook();
    const home = await makeHome();
    const app = await start({ library, home, args: ['--profile', 'cli'], env: { STORYFORGE_PROFILE: 'env' } });
    assert.equal((await app.get('/api/preferences')).json.profile.name, 'cli');
    await app.stop();
    const plain = await start({ library, home });
    assert.equal((await plain.get('/api/preferences')).json.profile.name, 'default');
    await plain.stop();
    const bad = await runMain(['--library', library, '--profile', 'Bad Name!'], { home });
    assert.equal(bad.code, 2);
    assert.match(bad.out, /bad profile name/);
    const missing = await runMain(['--library', library, '--profile'], { home });
    assert.equal(missing.code, 2);
  });

  test('the switcher: create a profile, switch to it, the choices follow; the default cannot be deleted; the one in use cannot be deleted', async () => {
    const library = await freshBook();
    const home = await makeHome();
    const app = await start({ library, home });
    const before = await everything(library);
    assert.equal((await app.put('/api/profile', { theme: 'high-contrast' })).status, 200);
    assert.equal((await app.post('/api/profile/switch', { name: 'night' })).status, 404, 'an unknown profile is not created by accident');
    const made = await app.post('/api/profile/switch', { name: 'night', create: true });
    assert.equal(made.status, 200, made.text);
    let prefs = (await app.get('/api/preferences')).json;
    assert.equal(prefs.profile.name, 'night');
    assert.deepEqual(prefs.profile.names, ['default', 'night']);
    assert.equal(prefs.effective.theme, 'dark', 'the new profile starts from the defaults');
    assert.equal((await app.del('/api/profiles/night')).status, 409);
    assert.equal((await app.post('/api/profile/switch', { name: 'default' })).status, 200);
    prefs = (await app.get('/api/preferences')).json;
    assert.equal(prefs.effective.theme, 'high-contrast');
    assert.equal((await app.del('/api/profiles/night')).status, 200);
    assert.equal((await app.del('/api/profiles/default')).status, 409, 'in use');
    assert.equal((await app.post('/api/profile/switch', { name: 'other', create: true })).status, 200);
    assert.equal((await app.del('/api/profiles/default')).status, 404, 'the default profile cannot be deleted at all');
    assert.equal((await app.post('/api/profile/switch', { name: '../evil', create: true })).status, 400);
    await app.stop();
    assert.deepEqual(await everything(library), before);
  });

  test('saving a profile validates it: ranges, chords (reserved ones are refused), unknown keys and bad colours are 400 BAD_PROFILE and nothing is stored', async () => {
    const library = await freshBook();
    const home = await makeHome();
    const app = await start({ library, home });
    const bad = [
      { typography: { size: 40 } },
      { typography: { measure: 'wide' } },
      { theme: 'neon' },
      { shortcuts: { 'editor.bold': 'Ctrl+W' } },
      { shortcuts: { 'editor.bold': 'Tab' } },
      { shortcuts: { 'editor.bold': 'F5' } },
      { shortcuts: { 'editor.bold': 'Alt+F4' } },
      { shortcuts: { 'editor.bold': 'not a chord' } },
      { modules: { telepathy: true } },
      { layout: { rail: { width: 10 } } },
      { customThemes: { Bad: { '--bg': 'red' } } },
      { customThemes: { Bad: { '--nope': '#000000' } } },
      { colour: 'red' },
    ];
    for (const body of bad) {
      const r = await app.put('/api/profile', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.code, 'BAD_PROFILE', JSON.stringify(body));
    }
    assert.equal((await app.get('/api/preferences')).json.effective.typography.size, 18);
    const good = await app.put('/api/profile', { customThemes: { Paper: { '--bg': '#FFFFFF' } }, theme: 'custom:Paper', layouts: { Mine: { rail: { shown: true, width: 200 } } }, layout: { name: 'Mine' } });
    assert.equal(good.status, 200, good.text);
    const prefs = (await app.get('/api/preferences')).json;
    assert.equal(prefs.effective.theme, 'custom:Paper');
    assert.deepEqual(prefs.profile.customThemes.Paper, { '--bg': '#FFFFFF' });
    assert.equal((await app.put('/api/profile', { theme: null })).status, 200, 'null removes a key');
    assert.equal((await app.get('/api/preferences')).json.effective.theme, 'dark');
    await app.stop();
  });
});

// ---------------------------------------------------------------- acceptance 2: the precedence table, through the API

describe('precedence through the API', () => {
  test('appearance: built-in < library < book < profile; project: built-in < profile < library < book; project off beats profile on', async () => {
    const library = await projectLibrary('  theme: light\n  typography:\n    size: 20\n    family: mono\n  modules:\n    ai: false\n    timeline: true\n  export:\n    format: epub\n');
    await setBookPreferences(path.join(library, 'salt-orchard'), '  theme: high-contrast\n  typography:\n    lineHeight: 1.9\n  modules:\n    research: false\n  export:\n    include: manuscript\n');
    const home = await makeHome();
    const app = await start({ library, home });
    // no profile choices yet: the book overrides the library, the library the built-ins
    let p = (await app.get(`/api/preferences?book=${BOOK}`)).json;
    assert.equal(p.effective.theme, 'high-contrast');
    assert.equal(p.sources.theme, 'book');
    assert.equal(p.effective.typography.size, 20);
    assert.equal(p.sources['typography.size'], 'library');
    assert.equal(p.effective.typography.family, 'mono');
    assert.equal(p.effective.typography.lineHeight, 1.9);
    assert.equal(p.sources['typography.lineHeight'], 'book');
    assert.equal(p.effective.typography.letterSpacing, 0);
    assert.equal(p.sources['typography.letterSpacing'], 'builtin');
    // without a book only the library layer applies
    const lib = (await app.get('/api/preferences')).json;
    assert.equal(lib.effective.theme, 'light');
    assert.equal(lib.modules.research.on, true);

    // the profile: it wins on appearance, and loses on project keys
    assert.equal((await app.put('/api/profile', { theme: 'dark', typography: { size: 16 }, modules: { ai: true, board: false, research: true }, export: { format: 'docx' } })).status, 200);
    p = (await app.get(`/api/preferences?book=${BOOK}`)).json;
    assert.equal(p.effective.theme, 'dark');
    assert.equal(p.sources.theme, 'profile');
    assert.equal(p.effective.typography.size, 16);
    assert.equal(p.sources['typography.size'], 'profile');
    assert.equal(p.effective.typography.family, 'mono', 'a leaf the profile does not set still comes from the library');
    assert.equal(p.modules.ai.on, false, 'project off beats profile on');
    assert.equal(p.modules.ai.locked, true);
    assert.equal(p.modules.ai.source, 'library');
    assert.equal(p.modules.research.on, false, 'the book turns research off though the profile wants it on');
    assert.equal(p.modules.research.source, 'book');
    assert.equal(p.modules.board.on, false, 'a module the project leaves unset follows the profile');
    assert.equal(p.modules.board.locked, false);
    assert.equal(p.modules.timeline.on, true);
    assert.equal(p.effective.export.format, 'epub', 'library beats profile on project keys');
    assert.equal(p.effective.export.include, 'manuscript');
    assert.deepEqual(p.warnings.map((w) => w.code), ['AI_OFF']);
    await app.stop();
  });

  test('preferences in library.md and book.md are validated: an unknown key is I401, a wrong type E102 at preferences.<key>, and a good map is clean', async () => {
    const library = await projectLibrary('  modules:\n    ai: maybe\n  colour: red\n');
    await setBookPreferences(path.join(library, 'salt-orchard'), '  typography:\n    size: 99\n');
    const app = await start({ library, home: await makeHome() });
    const diags = (await app.get('/api/library')).json.diagnostics;
    const keyOf = (d) => `${d.code} ${d.file} ${d.location}`;
    assert.ok(diags.map(keyOf).includes('E102 library.md preferences.modules.ai'), diags.map(keyOf).join('\n'));
    assert.ok(diags.map(keyOf).includes('I401 library.md preferences.colour'));
    assert.ok(diags.map(keyOf).includes('E102 salt-orchard/book.md preferences.typography.size'));
    // the broken values are ignored by the resolver, the good ones still apply
    const p = (await app.get(`/api/preferences?book=${BOOK}`)).json;
    assert.equal(p.effective.typography.size, 18);
    assert.equal(p.modules.ai.on, true);
    assert.equal((await app.get('/api/preferences?book=book_01S5ZZZZZZZZZZZZZZZZZZZZZZ')).status, 404);
    await app.stop();
  });
});

// ---------------------------------------------------------------- acceptance 4: modules

/** One write route per module that has write routes, with a body that would be valid when the module is on. */
const MODULE_WRITES = {
  continuity: ['POST', bookUrl('/continuity/exceptions'), { fingerprint: 'cf1-0123456789abcdef', rationale: 'because' }],
  receipts: ['POST', bookUrl('/receipts/flush'), { sceneId: SCENE }],
  suggestions: ['POST', bookUrl('/suggestions/note_01S5ZZZZZZZZZZZZZZZZZZZZZZ'), { decision: 'accept' }],
  timeline: ['POST', bookUrl('/events'), { title: 'The ferry sinks', slug: 'ferry-sinks', order: 9000 }],
  threads: ['POST', bookUrl('/threads'), { title: 'A new thread', slug: 'a-new-thread' }],
  research: ['POST', bookUrl('/notes'), { kind: 'research', title: 'Harbour dredging', slug: 'harbour-dredging' }],
  ai: ['POST', bookUrl('/ai/context'), { task: 'chat', files: ['book.md'], instruction: 'hello' }],
};

describe('modules', () => {
  test('a module turned off in the profile refuses its writes with 403 MODULE_OFF and writes nothing; on, the same route is not refused for that reason', async () => {
    const library = await freshBook();
    const home = await makeHome();
    const app = await start({ library, home });
    for (const [id, [method, url, body]] of Object.entries(MODULE_WRITES)) {
      // on: whatever the route answers, it is not MODULE_OFF
      const on = await send(app.port, method, url, body);
      assert.notEqual(on.json?.code, 'MODULE_OFF', `${id} on: ${on.status} ${on.text}`);
      // off
      assert.equal((await app.put('/api/profile', { modules: { [id]: false } })).status, 200);
      const before = await everything(library);
      const off = await send(app.port, method, url, body);
      assert.equal(off.status, 403, `${id} off: ${off.text}`);
      assert.equal(off.json.error, 'MODULE_OFF');
      assert.equal(off.json.code, 'MODULE_OFF');
      assert.equal(off.json.module, id);
      assert.deepEqual(await everything(library), before, `${id}: nothing was written`);
      assert.equal((await app.put('/api/profile', { modules: null })).status, 200);
    }
    // the files of a module that is off stay on disk, untouched and still validated: break an event file by hand, turn the modules off, and it is still reported
    const flood = path.join(library, 'planning', 'timeline', 'the-flood.md');
    await fs.writeFile(flood, (await fs.readFile(flood, 'utf8')).replace(/^order: .*$/m, 'order: not-a-number'));
    const reported = async () => (await app.get(bookUrl('/diagnostics'))).json.filter((d) => d.file.endsWith('the-flood.md')).map((d) => `${d.code} ${d.location}`);
    await new Promise((r) => setTimeout(r, 400));
    const withOn = await reported();
    assert.ok(withOn.includes('E102 order'), withOn.join(', '));
    assert.equal((await app.put('/api/profile', { modules: { timeline: false, research: false, threads: false } })).status, 200);
    const filesBefore = await listFiles(library);
    assert.deepEqual(await reported(), withOn, 'still validated with the module off');
    assert.deepEqual(await listFiles(library), filesBefore, 'and untouched');
    await app.stop();
  });

  test('the file upload of the research module is refused too, with the module off', async () => {
    const library = await freshBook();
    const app = await start({ library, home: await makeHome() });
    assert.equal((await app.put('/api/profile', { modules: { research: false } })).status, 200);
    const before = await everything(library);
    const r = await send(app.port, 'POST', bookUrl('/attachments?name=notes.txt'), 'hello');
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.deepEqual(await everything(library), before);
    await app.stop();
  });

  test('a module the project turns off (library.md or book.md) is off whatever the profile says; reads, the scene body and the other modules are unaffected', async () => {
    const library = await projectLibrary('  modules:\n    timeline: false\n');
    await setBookPreferences(path.join(library, 'salt-orchard'), '  modules:\n    threads: false\n');
    const app = await start({ library, home: await makeHome() });
    assert.equal((await app.put('/api/profile', { modules: { timeline: true, threads: true } })).status, 200);
    const before = await everything(library);
    for (const id of ['timeline', 'threads']) {
      const [method, url, body] = MODULE_WRITES[id];
      const r = await send(app.port, method, url, body);
      assert.equal(r.status, 403, `${id}: ${r.text}`);
      assert.equal(r.json.module, id);
    }
    assert.deepEqual(await everything(library), before);
    // a read still works, and the scene save (not a module) is not touched by any of this
    assert.equal((await app.get(bookUrl('/timeline'))).status, 200);
    const scene = (await app.get(bookUrl(`/scenes/${SCENE}`))).json;
    const saved = await app.put(bookUrl(`/scenes/${SCENE}/body`), { body: `${scene.body}\nA line.\n`, base_sha256: scene.sha256 });
    assert.equal(saved.status, 200, saved.text);
    // other modules are on: not refused
    const notes = await send(app.port, ...MODULE_WRITES.research);
    assert.notEqual(notes.json?.code, 'MODULE_OFF');
    // the answer says why
    const p = (await app.get(`/api/preferences?book=${BOOK}`)).json;
    assert.deepEqual([p.modules.timeline.on, p.modules.timeline.locked, p.modules.timeline.source], [false, true, 'library']);
    assert.deepEqual([p.modules.threads.on, p.modules.threads.locked, p.modules.threads.source], [false, true, 'book']);
    await app.stop();
  });

  test('every module id is answered, and the ones without write routes of their own (board, insights, tasks) are gated by id for their pages', async () => {
    const app = await start({ library: await freshBook(), home: await makeHome() });
    const p = (await app.get('/api/preferences')).json;
    assert.deepEqual(Object.keys(p.modules).sort(), ['ai', 'board', 'continuity', 'insights', 'integrations', 'receipts', 'research', 'suggestions', 'tasks', 'threads', 'timeline']);
    assert.deepEqual(p.moduleIds.slice().sort(), Object.keys(p.modules).sort());
    assert.equal((await app.put('/api/profile', { modules: { board: false, insights: false, tasks: false } })).status, 200);
    const off = (await app.get('/api/preferences')).json.modules;
    assert.deepEqual([off.board.on, off.insights.on, off.tasks.on], [false, false, false]);
    await app.stop();
  });

  test('receipts off: a save records no new receipt and the answer warns about the gap; back on, receipts are written again', async () => {
    const library = await freshBook();
    const app = await start({ library, home: await makeHome() });
    const receiptFiles = async () => (await listFiles(library)).filter((f) => f.startsWith('provenance/') && f.endsWith('.md'));
    const save = async (line) => {
      const scene = (await app.get(bookUrl(`/scenes/${KEY_SCENE}`))).json;
      const r = await app.put(bookUrl(`/scenes/${KEY_SCENE}/body`), { body: `${scene.body}\n${line}\n`, base_sha256: scene.sha256 });
      assert.equal(r.status, 200, r.text);
      await app.post(bookUrl('/receipts/flush'), { sceneId: KEY_SCENE });
    };
    assert.equal((await receiptFiles()).length, 0);
    assert.equal((await app.put('/api/profile', { modules: { receipts: false } })).status, 200);
    const p = (await app.get(`/api/preferences?book=${BOOK}`)).json;
    assert.deepEqual(p.warnings.map((w) => w.code), ['RECEIPTS_GAP']);
    assert.match(p.warnings[0].message, /gap/);
    await save('Off one.');
    await save('Off two.');
    assert.equal((await receiptFiles()).length, 0, 'no receipt while the module is off');
    const flush = await app.post(bookUrl('/receipts/flush'), { sceneId: KEY_SCENE });
    assert.equal(flush.status, 403, 'the receipts flush is a write of the receipts module');
    assert.equal((await app.put('/api/profile', { modules: { receipts: true } })).status, 200);
    await save('On one.');
    await save('On two.');
    assert.ok((await receiptFiles()).length >= 1, 'receipts are written again once the module is on');
    const verified = await app.get(bookUrl('/receipts/verify'));
    assert.equal(verified.status, 200, verified.text);
    await app.stop();
  });

  test('the AI module off sends zero network traffic, even with a provider set up; with it on the same request does go out (positive control)', async () => {
    const library = await freshBook();
    const home = await makeHome();
    const provider = await startMockProvider({ reply: 'A tighter line.' });
    const app = await start({ library, home, net: true });
    await setupProvider(app, { baseUrl: provider.baseUrl });
    assert.equal((await app.put('/api/profile', { modules: { ai: false } })).status, 200);
    const before = await everything(library);
    const profileId = (await app.get('/api/ai/profiles')).json.profiles[0].id;
    const attempts = [
      ['POST', bookUrl('/ai/context'), { task: 'chat', files: ['book.md'], instruction: 'hello' }],
      ['POST', bookUrl('/ai/send'), { contextId: 'ctx_nope' }],
      ['POST', bookUrl('/ai/apply'), { contextId: 'ctx_nope' }],
      ['POST', bookUrl('/ai/discard'), { contextId: 'ctx_nope' }],
      ['POST', `/api/ai/profiles/${profileId}/test`, {}],
    ];
    for (const [method, url, body] of attempts) {
      const r = await send(app.port, method, url, body);
      assert.equal(r.status, 403, `${url}: ${r.text}`);
      assert.equal(r.json.code, 'MODULE_OFF', url);
    }
    assert.deepEqual(await app.netCalls(), [], 'the transport was never called');
    assert.equal(provider.calls.length, 0, 'the provider saw nothing');
    assert.deepEqual(await everything(library), before);

    // positive control: switch AI back on: the same request makes a call
    assert.equal((await app.put('/api/profile', { modules: { ai: true } })).status, 200);
    const ctx = await app.post(bookUrl('/ai/context'), { task: 'chat', files: ['book.md'], instruction: 'hello' });
    assert.equal(ctx.status, 200, ctx.text);
    assert.equal(provider.calls.length, 0, 'a preview sends nothing');
    const sent = await app.post(bookUrl('/ai/send'), { contextId: ctx.json.contextId });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(provider.calls.length, 1);
    assert.ok((await app.netCalls()).length >= 1, 'the recorder sees the call');
    await provider.close();
    await app.stop();
  });

  test('the suggestions module off: an AI rewrite is not turned into a suggestion file', async () => {
    const library = await freshBook();
    const provider = await startMockProvider({ reply: 'Maren stepped off the ferry.' });
    const app = await start({ library, home: await makeHome() });
    await setupProvider(app, { baseUrl: provider.baseUrl });
    assert.equal((await app.put('/api/profile', { modules: { suggestions: false } })).status, 200);
    const scene = (await app.get(bookUrl(`/scenes/${SCENE}`))).json;
    const from = scene.body.indexOf('The ferry nudged');
    const ctx = await app.post(bookUrl('/ai/context'), { task: 'rewrite', files: [], instruction: 'tighter', selection: { sceneId: SCENE, from, to: from + 16 } });
    assert.equal(ctx.status, 200, ctx.text);
    const sent = await app.post(bookUrl('/ai/send'), { contextId: ctx.json.contextId });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.suggestion ?? null, null);
    assert.ok(!(await listFiles(library)).some((f) => f.startsWith('suggestions/')), 'no suggestion file');
    await provider.close();
    await app.stop();
  });
});

// ---------------------------------------------------------------- acceptance 5: custom prompts

describe('custom prompt components and workflows', () => {
  async function promptLibrary() {
    const library = await projectLibrary();
    await writePrompt(library, 'tighten-dialogue.md', promptFile());
    await writePrompt(library, 'summarise.md', promptFile({ id: ID_B, slug: 'summarise', name: 'Summarise', inputs: '[scene, entries]', task: 'chat', body: 'Summarise {{scene}} for {{entries.name}}. Earlier: {{previous}}\n' }));
    await writePrompt(library, 'workflows/polish.md', workflowFile());
    return library;
  }

  test('the library lists its prompts and workflows with their problems; the scanner does not treat _prompts as a book; unknown placeholders are E102 at body with the line', async () => {
    const library = await promptLibrary();
    await writePrompt(library, 'broken.md', promptFile({ id: 'note_01S5000000000000000000000D', slug: 'broken', name: 'Broken', body: 'Line one.\nLine two {{nonsense}}.\n' }));
    const app = await start({ library, home: await makeHome() });
    const list = (await app.get('/api/prompts')).json;
    assert.deepEqual(list.prompts.map((p) => p.slug).sort(), ['broken', 'summarise', 'tighten-dialogue']);
    assert.deepEqual(list.workflows.map((w) => w.slug), ['polish']);
    assert.equal(list.prompts.find((p) => p.slug === 'tighten-dialogue').problems.length, 0);
    const broken = list.prompts.find((p) => p.slug === 'broken');
    assert.equal(broken.problems[0].code, 'E102');
    assert.equal(broken.problems[0].location, 'body');
    assert.match(broken.problems[0].message, /\{\{nonsense\}\} on line 10/);
    const lib = (await app.get('/api/library')).json;
    assert.ok(lib.diagnostics.some((d) => d.file === '_prompts/broken.md' && d.code === 'E102' && d.location === 'body'));
    assert.equal((await app.get('/api/books')).json.length, 1, '_prompts holds no book');
    await app.stop();
  });

  test('the preview lists exactly the selected sources, nothing is sent until Send, and a rewrite comes back as a suggestion that changes no scene', async () => {
    const library = await promptLibrary();
    const provider = await startMockProvider({ reply: 'Maren stepped ashore.' });
    const app = await start({ library, home: await makeHome(), net: true });
    await setupProvider(app, { baseUrl: provider.baseUrl });
    const scene = (await app.get(bookUrl(`/scenes/${SCENE}`))).json;
    const from = scene.body.indexOf('The ferry');
    const selection = { sceneId: SCENE, from, to: from + 30 };
    const before = await everything(library);
    const sceneRel = scene.path.replace(/^salt-orchard\//, ''); // the API says library-relative paths; the context lists book-relative ones
    const sceneBefore = await readFile(library, scene.path);

    const preview = await app.post(bookUrl('/ai/context'), { prompt: { slug: 'tighten-dialogue', inputs: { sceneId: SCENE, selection } } });
    assert.equal(preview.status, 200, preview.text);
    const pkg = preview.json;
    // exactly the sources the prompt reads: the scene file and the point-of-view entry (from the scene), plus the selected text
    assert.deepEqual(pkg.sources.map((s) => [s.input, s.path]), [['selection', null], ['scene', sceneRel], ['pov-entry', 'codex/characters/maren-hollis.md']]);
    assert.deepEqual(pkg.files.map((f) => f.path), [sceneRel, 'codex/characters/maren-hollis.md']);
    for (const f of pkg.files) assert.ok(f.bytes > 0 && f.tokens > 0 && f.included === 'full', JSON.stringify(f));
    assert.ok(pkg.tokens.estimate > 0);
    assert.deepEqual(pkg.prompt, { slug: 'tighten-dialogue', name: 'Tighten dialogue', task: 'rewrite', workflow: null, step: null, steps: null });
    assert.match(pkg.messages[1].content, /Keep Maren Hollis's voice/, 'the placeholder was filled from the entry');
    assert.equal(pkg.selection.text, scene.body.slice(selection.from, selection.to));
    // nothing sent, nothing written
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(await app.netCalls(), []);
    assert.deepEqual(await everything(library), before);

    // Send: exactly one request, with exactly the previewed messages
    const sent = await app.post(bookUrl('/ai/send'), { contextId: pkg.contextId });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(provider.calls[0].body.messages, pkg.messages);
    assert.ok(sent.json.suggestion, 'a rewrite is a suggestion');
    assert.equal(await readFile(library, scene.path), sceneBefore, 'the scene is not changed by a rewrite until it is accepted');
    await provider.close();
    await app.stop();
  });

  test('the errors are named and refuse before anything is sent: unknown prompt, a missing input, an unknown entry', async () => {
    const library = await promptLibrary();
    await writePrompt(library, 'broken.md', promptFile({ id: 'note_01S5000000000000000000000D', slug: 'broken', name: 'Broken', body: '{{nonsense}}\n' }));
    const provider = await startMockProvider();
    const app = await start({ library, home: await makeHome(), net: true });
    await setupProvider(app, { baseUrl: provider.baseUrl });
    const ask = (prompt) => app.post(bookUrl('/ai/context'), { prompt });
    assert.equal((await ask({ slug: 'nope', inputs: {} })).json.code, 'PROMPT_NOT_FOUND');
    assert.equal((await ask({ slug: 'broken', inputs: {} })).json.code, 'PROMPT_INVALID');
    const noSelection = await ask({ slug: 'tighten-dialogue', inputs: { sceneId: SCENE } });
    assert.equal(noSelection.status, 400);
    assert.equal(noSelection.json.code, 'MISSING_INPUT');
    assert.match(noSelection.json.message, /selection/);
    const noEntries = await ask({ slug: 'summarise', inputs: { sceneId: SCENE } });
    assert.equal(noEntries.json.code, 'MISSING_INPUT');
    assert.equal((await ask({ slug: 'summarise', inputs: { sceneId: SCENE, entries: ['no-such-entry'] } })).status, 404);
    assert.equal((await ask({ workflow: 'polish', step: 7, inputs: {} })).status, 400);
    assert.equal((await ask('nope')).status, 400);
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(await app.netCalls(), []);
    await provider.close();
    await app.stop();
  });

  test('a workflow: each step is its own preview and its own Send; the reply of one step is {{previous}} of the next', async () => {
    const library = await promptLibrary();
    const provider = await startMockProvider({ reply: 'FIRST-REPLY about the harbour' });
    const app = await start({ library, home: await makeHome(), net: true });
    await setupProvider(app, { baseUrl: provider.baseUrl });
    // step 1 needs the selection; step 2 (summarise) needs entries: the workflow's steps declare their own inputs
    const scene = (await app.get(bookUrl(`/scenes/${SCENE}`))).json;
    const from = scene.body.indexOf('The ferry');
    const inputs = { sceneId: SCENE, selection: { sceneId: SCENE, from, to: from + 20 }, entries: [MAREN] };

    const one = await app.post(bookUrl('/ai/context'), { prompt: { workflow: 'polish', step: 0, inputs } });
    assert.equal(one.status, 200, one.text);
    assert.deepEqual([one.json.prompt.workflow, one.json.prompt.step, one.json.prompt.steps, one.json.prompt.slug], ['polish', 0, 2, 'tighten-dialogue']);
    assert.equal(provider.calls.length, 0, 'a preview sends nothing');
    const sent1 = await app.post(bookUrl('/ai/send'), { contextId: one.json.contextId });
    assert.equal(sent1.status, 200, sent1.text);
    assert.equal(provider.calls.length, 1);

    // the next step is NOT sent by finishing the first: it needs its own preview and its own Send
    assert.equal(provider.calls.length, 1);
    provider.setReply('SECOND-REPLY');
    const two = await app.post(bookUrl('/ai/context'), { prompt: { workflow: 'polish', step: 1, previous: sent1.json.reply, inputs } });
    assert.equal(two.status, 200, two.text);
    assert.deepEqual([two.json.prompt.step, two.json.prompt.slug, two.json.prompt.task], [1, 'summarise', 'chat']);
    assert.match(two.json.messages[1].content, /Earlier: FIRST-REPLY about the harbour/, '{{previous}} is the reply of the step before');
    assert.deepEqual(two.json.sources.map((s) => s.input), ['scene', 'entries']);
    assert.equal(provider.calls.length, 1, 'still only the first step was sent');
    const sent2 = await app.post(bookUrl('/ai/send'), { contextId: two.json.contextId });
    assert.equal(sent2.status, 200);
    assert.equal(provider.calls.length, 2);
    assert.equal(sent2.json.reply, 'SECOND-REPLY');
    // the first step's preview cannot be sent twice as "the next step" either: each Send needs its own contextId
    const again = await app.post(bookUrl('/ai/send'), { contextId: 'ctx_missing' });
    assert.equal(again.status, 404);
    assert.equal(provider.calls.length, 2);
    await provider.close();
    await app.stop();
  });

  test('prompts follow the AI module: with it off a prompt run is refused (403 MODULE_OFF) and nothing is called', async () => {
    const library = await promptLibrary();
    const provider = await startMockProvider();
    const app = await start({ library, home: await makeHome(), net: true });
    await setupProvider(app, { baseUrl: provider.baseUrl });
    assert.equal((await app.put('/api/profile', { modules: { ai: false } })).status, 200);
    const r = await app.post(bookUrl('/ai/context'), { prompt: { slug: 'summarise', inputs: { sceneId: SCENE, entries: [MAREN] } } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(await app.netCalls(), []);
    await provider.close();
    await app.stop();
  });
});
