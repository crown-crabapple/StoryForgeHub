// M07-J04: preferences (layers, precedence, validation) and custom prompt components / workflows (parse, placeholder errors, scanner skip).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, resolvePreferences, resolveModules, MODULE_IDS, BUILTIN, checkPreferenceMap, moduleOfRoute, parsePromptFile, loadPrompts, renderPrompt, placeholdersOf } from '../src/index.mjs';
import { keyOf } from './helpers.mjs';

const temps = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-custom-'));
  temps.push(d);
  return d;
};

// ---------------------------------------------------------------- precedence (contract section 1)

test('precedence: with no layers every key is the built-in default (dark, serif 18, Writing, every module on)', () => {
  const { values, sources } = resolvePreferences();
  assert.equal(values.theme, 'dark');
  assert.deepEqual(values.typography, BUILTIN.typography);
  assert.equal(values.layout.name, 'Writing');
  assert.ok(MODULE_IDS.every((id) => values.modules[id] === true));
  assert.equal(sources.theme, 'builtin');
});

test('precedence: appearance keys are built-in < library < book < profile (the person at the keyboard wins)', () => {
  const r = resolvePreferences({ library: { theme: 'light' }, book: { theme: 'high-contrast' }, profile: { theme: 'dark' } });
  assert.equal(r.values.theme, 'dark');
  assert.equal(r.sources.theme, 'profile');
  const noProfile = resolvePreferences({ library: { theme: 'light' }, book: { theme: 'high-contrast' } });
  assert.equal(noProfile.values.theme, 'high-contrast');
  assert.equal(noProfile.sources.theme, 'book');
  const libOnly = resolvePreferences({ library: { theme: 'light' } });
  assert.equal(libOnly.values.theme, 'light');
  assert.equal(libOnly.sources.theme, 'library');
});

test('precedence: typography, layout and shortcuts merge key by key, each leaf from its own winning layer', () => {
  const r = resolvePreferences({
    library: { typography: { size: 20, family: 'sans' }, shortcuts: { 'editor.bold': 'Mod+Shift+B' } },
    book: { typography: { lineHeight: 1.9 }, layout: { name: 'Review', inspector: { width: 400 } } },
    profile: { typography: { size: 16 }, shortcuts: { 'editor.italic': null }, layout: { name: 'Planning' } },
  });
  assert.equal(r.values.typography.size, 16);
  assert.equal(r.sources['typography.size'], 'profile');
  assert.equal(r.values.typography.family, 'sans');
  assert.equal(r.sources['typography.family'], 'library');
  assert.equal(r.values.typography.lineHeight, 1.9);
  assert.equal(r.sources['typography.lineHeight'], 'book');
  assert.equal(r.values.typography.letterSpacing, 0);
  assert.equal(r.sources['typography.letterSpacing'], 'builtin');
  assert.equal(r.values.layout.name, 'Planning');
  assert.equal(r.values.layout.inspector.width, 400);
  assert.deepEqual(r.values.shortcuts, { 'editor.bold': 'Mod+Shift+B', 'editor.italic': null });
});

test('precedence: project keys (modules, labels, export) are built-in < profile < library < book', () => {
  const r = resolvePreferences({
    profile: { modules: { timeline: false, board: false }, export: { format: 'docx' }, labels: { display: 'text' } },
    library: { modules: { board: true }, export: { format: 'epub' } },
    book: { export: { include: 'manuscript' } },
  });
  assert.equal(r.values.modules.timeline, false, 'a profile may turn a module off when the project says nothing');
  assert.equal(r.sources['modules.timeline'], 'profile');
  assert.equal(r.values.modules.board, true, 'the library beats the profile');
  assert.equal(r.sources['modules.board'], 'library');
  assert.deepEqual(r.values.export, { format: 'epub', include: 'manuscript' });
  assert.equal(r.sources['export.format'], 'library');
  assert.equal(r.sources['export.include'], 'book');
  assert.equal(r.values.labels.display, 'text');
  assert.equal(r.sources['labels.display'], 'profile');
});

test('precedence: a module the project turns off cannot be turned on by a profile; an unset module follows the profile', () => {
  const lib = resolveModules({ library: { modules: { ai: false } }, profile: { modules: { ai: true, timeline: false } } });
  assert.equal(lib.ai.on, false);
  assert.equal(lib.ai.locked, true);
  assert.equal(lib.ai.source, 'library');
  assert.equal(lib.timeline.on, false);
  assert.equal(lib.timeline.locked, false);
  assert.equal(lib.timeline.source, 'profile');
  assert.equal(lib.board.on, true);
  const book = resolveModules({ book: { modules: { ai: false } }, profile: { modules: { ai: true } } });
  assert.equal(book.ai.on, false, 'project off beats profile on');
  const both = resolveModules({ library: { modules: { ai: false } }, book: { modules: { ai: true } }, profile: {} });
  assert.equal(both.ai.on, true, 'the book is the later project layer');
});

test('precedence: a value that fails validation is ignored by the resolver (the validator reports it)', () => {
  const r = resolvePreferences({ book: { theme: 'neon', typography: { size: 99, family: 'mono' } } });
  assert.equal(r.values.theme, 'dark');
  assert.equal(r.values.typography.size, 18);
  assert.equal(r.values.typography.family, 'mono');
});

test('the resolver does not change the layers it is given', () => {
  const lib = { modules: { ai: false }, typography: { size: 20 } };
  const copy = JSON.stringify(lib);
  resolvePreferences({ library: lib, profile: { typography: { size: 15 } } });
  assert.equal(JSON.stringify(lib), copy);
  assert.equal(BUILTIN.typography.size, 18);
});

// ---------------------------------------------------------------- validation (I401 / E102)

test('checkPreferenceMap: unknown key is I401, wrong value types are E102 at preferences.<key>', () => {
  const found = checkPreferenceMap({ modules: { ai: 'no', nonsense: true }, theme: 5, typography: { size: 40, measure: 'wide' }, color: 'red', layout: { rail: { width: 10 } }, shortcuts: { 'editor.bold': 7 }, labels: [], export: {} });
  const keys = found.map((d) => `${d.code} ${d.location}`).sort();
  assert.deepEqual(
    keys,
    [
      'E102 preferences.labels',
      'E102 preferences.layout.rail.width',
      'E102 preferences.modules.ai',
      'E102 preferences.modules.nonsense',
      'E102 preferences.shortcuts.editor.bold',
      'E102 preferences.theme',
      'E102 preferences.typography.measure',
      'E102 preferences.typography.size',
      'I401 preferences.color',
    ].sort(),
  );
  assert.deepEqual(checkPreferenceMap({ modules: { ai: false }, theme: 'custom:Sepia', typography: { size: 18, measure: 'full', family: 'accessible' }, layout: { name: 'Review', pinned: ['goal'] }, shortcuts: { 'editor.bold': null, 'focus.toggle': 'Mod+Shift+K' } }), []);
});

function library(extra = '') {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'library.md'), `---\nschema: storyforge.library/v1\nid: lib_01S5000000000000000000000A\ntitle: Test library\n${extra}---\n`);
  return root;
}

test('validate: library.md preferences are checked; a good map is clean, a bad one reports I401 and E102', async () => {
  const good = await validate(library('preferences:\n  modules:\n    ai: false\n  theme: light\n'));
  assert.deepEqual(good.diagnostics.map(keyOf), []);
  const bad = await validate(library('preferences:\n  modules:\n    ai: maybe\n  colour: red\n'));
  assert.deepEqual(bad.diagnostics.map(keyOf).sort(), ['E102 | library.md | preferences.modules.ai', 'I401 | library.md | preferences.colour']);
  const notMap = await validate(library('preferences: nope\n'));
  assert.deepEqual(notMap.diagnostics.map(keyOf), ['E102 | library.md | preferences']);
});

test('moduleOfRoute: write routes are classified by module', () => {
  assert.equal(moduleOfRoute('ai-send'), 'ai');
  assert.equal(moduleOfRoute('ai-profile-create'), null);
  assert.equal(moduleOfRoute('event-create'), 'timeline');
  assert.equal(moduleOfRoute('thread-body'), 'threads');
  assert.equal(moduleOfRoute('note-create'), 'research');
  assert.equal(moduleOfRoute('attachment-upload'), 'research');
  assert.equal(moduleOfRoute('continuity-exception-create'), 'continuity');
  assert.equal(moduleOfRoute('suggestion-decide'), 'suggestions');
  assert.equal(moduleOfRoute('receipts-flush'), 'receipts');
  assert.equal(moduleOfRoute('body'), null);
});

// ---------------------------------------------------------------- prompts (contract section 6)

const ID1 = 'note_01S5000000000000000000000A';
const ID2 = 'note_01S5000000000000000000000B';
const component = (over = {}, body = "Rewrite the selected dialogue so each line does one job. Keep {{pov-entry.name}}'s voice.\n") => {
  const fm = { schema: 'storyforge.prompt/v1', id: ID1, slug: 'tighten-dialogue', name: 'Tighten dialogue', inputs: '[selection, scene, pov-entry]', task: 'rewrite', ...over };
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

test('prompt: the contract example parses', () => {
  const r = parsePromptFile(component(), 'tighten-dialogue', 'prompt');
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.item.inputs, ['selection', 'scene', 'pov-entry']);
  assert.equal(r.item.task, 'rewrite');
  assert.equal(r.item.name, 'Tighten dialogue');
});

test('prompt: an unknown placeholder is E102 at body, naming the line', () => {
  const r = parsePromptFile(component({}, 'First line.\nSecond {{selection}} line.\nThird {{nonsense}} here.\n'), 'tighten-dialogue', 'prompt');
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.location === 'body');
  assert.equal(p.code, 'E102');
  assert.match(p.message, /unknown placeholder \{\{nonsense\}\} on line 11/); // the front matter is lines 1-8, the body starts on line 9; its third line is line 11
});

test('prompt: a placeholder for an input the prompt does not declare, or a field the input does not have, is unknown', () => {
  const noInput = parsePromptFile(component({ inputs: '[selection]' }, '{{scene}}\n'), 'tighten-dialogue', 'prompt');
  assert.ok(noInput.problems.some((p) => p.location === 'body' && /\{\{scene\}\}/.test(p.message)));
  const noField = parsePromptFile(component({}, '{{pov-entry.shoe-size}}\n'), 'tighten-dialogue', 'prompt');
  assert.ok(noField.problems.some((p) => p.location === 'body' && /shoe-size/.test(p.message)));
  const ok = parsePromptFile(component({}, '{{selection}} {{scene}} {{pov-entry.name}} {{pov-entry.body}} {{previous}}\n'), 'tighten-dialogue', 'prompt');
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test('prompt: other shape errors are E102 at the field', () => {
  const loc = (text, stem = 'tighten-dialogue') => parsePromptFile(text, stem, 'prompt').problems.map((p) => `${p.code} ${p.location}`);
  assert.deepEqual(loc(component({ schema: 'storyforge.prompt/v2' })), ['E102 schema']);
  assert.deepEqual(loc(component({ task: 'sing' })), ['E102 task']);
  assert.ok(loc(component({ inputs: '[scene, moon]' })).includes('E102 inputs'));
  assert.deepEqual(loc(component({ slug: 'other' })), ['E102 slug']);
  assert.deepEqual(loc(component({ id: 'scene_01S5000000000000000000000A' })), ['E102 id']);
  assert.deepEqual(loc(component({ name: undefined })), ['E102 name']);
  assert.ok(loc(component({ inputs: '[scene]' })).includes('E102 inputs'), 'a rewrite needs the selection input');
});

test('prompt: placeholdersOf finds each {{...}} with its line', () => {
  const found = placeholdersOf('a {{selection}}\n\nb {{ entries.name }} {{previous}}', 10);
  assert.deepEqual(
    found.map((p) => [p.name, p.field, p.line]),
    [['selection', null, 10], ['entries', 'name', 12], ['previous', null, 12]],
  );
});

test('prompt: renderPrompt fills placeholders and lists the inputs that were not given', () => {
  const prompt = parsePromptFile(component({}, 'Voice of {{pov-entry.name}}. Text: {{selection}}. Before: {{previous}}.'), 'tighten-dialogue', 'prompt').item;
  const done = renderPrompt(prompt, { selection: 'Hello.', 'pov-entry': { name: 'Maren Hollis' }, previous: 'earlier' });
  assert.equal(done.text, 'Voice of Maren Hollis. Text: Hello.. Before: earlier.');
  assert.deepEqual(done.missing, []);
  const gaps = renderPrompt(prompt, { selection: 'Hello.' });
  assert.deepEqual(gaps.missing, ['pov-entry']);
  assert.equal(gaps.text, 'Voice of . Text: Hello.. Before: .');
});

test('workflow: steps must name valid prompts; _prompts/ is read by loadPrompts and skipped by the book scanner', async () => {
  const root = library();
  fs.mkdirSync(path.join(root, '_prompts', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '_prompts', 'tighten-dialogue.md'), component());
  fs.writeFileSync(path.join(root, '_prompts', 'workflows', 'polish.md'), `---\nschema: storyforge.prompt-workflow/v1\nid: ${ID2}\nslug: polish\nname: Polish\nsteps: [tighten-dialogue, missing-one]\n---\n`);
  fs.writeFileSync(path.join(root, '_prompts', 'book.md'), '---\nnot: a book\n---\nwords\n'); // looks like a book file, is a (bad) prompt
  const loaded = await loadPrompts(root);
  assert.deepEqual(loaded.prompts.map((p) => p.slug).sort(), ['book', 'tighten-dialogue']);
  assert.deepEqual(loaded.workflows.map((w) => w.slug), ['polish']);
  assert.ok(loaded.diagnostics.some((d) => d.file === '_prompts/workflows/polish.md' && d.location === 'steps[1]'));
  const result = await validate(root);
  assert.deepEqual(result.books, [], '_prompts/ holds no books');
  assert.ok(result.diagnostics.some((d) => d.file === '_prompts/workflows/polish.md' && d.code === 'E102' && d.location === 'steps[1]'));
  assert.ok(result.diagnostics.every((d) => d.file.startsWith('_prompts/')), 'nothing else is reported');
});
