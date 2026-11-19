// M13-J01: the `checks` preference (defaults, layering, each E102).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreferences, BUILTIN, PROJECT_KEYS, PREFERENCE_KEYS, checkPreferenceMap, preferenceProblems, INSPECTOR_SECTIONS } from '../src/index.mjs';

const DEFAULTS = {
  version: 1,
  grammar: { enabled: false, language: 'en', dialect: 'american', words: [], rules: {} },
  style: { enabled: false },
  epub: { validate: false },
};

const problems = (checks) => checkPreferenceMap({ checks }).map((d) => `${d.code} ${d.location}`);

test('checks is a project key and its built-in default is exactly the contract map, deeply frozen', () => {
  assert.ok(PROJECT_KEYS.includes('checks'));
  assert.ok(PREFERENCE_KEYS.includes('checks'));
  assert.deepEqual(BUILTIN.checks, DEFAULTS);
  assert.ok(Object.isFrozen(BUILTIN.checks));
  assert.ok(Object.isFrozen(BUILTIN.checks.grammar));
  assert.ok(Object.isFrozen(BUILTIN.checks.style));
  assert.ok(Object.isFrozen(BUILTIN.checks.epub));
});

test('a book that sets nothing resolves to the defaults: nothing runs', () => {
  const { values, sources } = resolvePreferences({});
  assert.deepEqual(values.checks, DEFAULTS);
  assert.equal(sources['checks.grammar.enabled'], 'builtin');
  assert.equal(sources['checks.epub.validate'], 'builtin');
});

test('layering: built-in < profile < library < book, key by key', () => {
  const profile = { checks: { grammar: { enabled: true }, style: { enabled: true } } };
  const library = { checks: { style: { enabled: false } } };
  const book = { checks: { epub: { validate: true } } };
  const { values, sources } = resolvePreferences({ profile, library, book });
  assert.deepEqual(values.checks, { version: 1, grammar: { enabled: true, language: 'en', dialect: 'american', words: [], rules: {} }, style: { enabled: false }, epub: { validate: true } });
  assert.equal(sources['checks.grammar.enabled'], 'profile');
  assert.equal(sources['checks.grammar.language'], 'builtin');
  assert.equal(sources['checks.style.enabled'], 'library');
  assert.equal(sources['checks.epub.validate'], 'book');
  // the project outranks the person: a book value beats a profile value
  const both = resolvePreferences({ profile: { checks: { grammar: { enabled: true } } }, book: { checks: { grammar: { enabled: false } } } });
  assert.equal(both.values.checks.grammar.enabled, false);
  assert.equal(both.sources['checks.grammar.enabled'], 'book');
});

test('a broken checks value is ignored by the resolver, the good parts are kept', () => {
  const { values } = resolvePreferences({ book: { checks: { grammar: { enabled: 'yes' }, style: { enabled: true } } } });
  assert.equal(values.checks.style.enabled, true);
  assert.equal(values.checks.grammar.enabled, false);
});

test('valid checks maps have no problems', () => {
  assert.deepEqual(problems(DEFAULTS), []);
  assert.deepEqual(problems({ version: 1 }), []);
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ grammar: { enabled: true, language: 'en' }, style: { enabled: true }, epub: { validate: true } }), []);
});

test('E102 for each bad case, at the right location', () => {
  assert.deepEqual(problems(5), ['E102 preferences.checks']);
  assert.deepEqual(problems([]), ['E102 preferences.checks']);
  assert.deepEqual(problems({ version: 2 }), ['E102 preferences.checks.version']);
  assert.deepEqual(problems({ version: '1' }), ['E102 preferences.checks.version']);
  assert.deepEqual(problems({ version: 0 }), ['E102 preferences.checks.version']);
  assert.deepEqual(problems({ grammar: { enabled: 'yes' } }), ['E102 preferences.checks.grammar.enabled']);
  assert.deepEqual(problems({ style: { enabled: 1 } }), ['E102 preferences.checks.style.enabled']);
  assert.deepEqual(problems({ epub: { validate: 'true' } }), ['E102 preferences.checks.epub.validate']);
  assert.deepEqual(problems({ grammar: { language: 'fr' } }), ['E102 preferences.checks.grammar.language']);
  assert.deepEqual(problems({ grammar: { language: 5 } }), ['E102 preferences.checks.grammar.language']);
  assert.deepEqual(problems({ grammar: true }), ['E102 preferences.checks.grammar']);
  assert.deepEqual(problems({ epub: null }), ['E102 preferences.checks.epub']);
});

test('unknown keys at any level are E102', () => {
  assert.deepEqual(problems({ spelling: { enabled: true } }), ['E102 preferences.checks.spelling']);
  assert.deepEqual(problems({ grammar: { spelling: {} } }), ['E102 preferences.checks.grammar.spelling']);
  assert.deepEqual(problems({ style: { enabled: true, language: 'en' } }), ['E102 preferences.checks.style.language']);
  assert.deepEqual(problems({ epub: { enabled: true } }), ['E102 preferences.checks.epub.enabled']);
});

test('the version message says the book was saved by a newer StoryForge', () => {
  const [p] = preferenceProblems('checks', { version: 2 });
  assert.equal(p.location, 'checks.version');
  assert.match(p.message, /newer StoryForge/);
});

test('several problems are all reported', () => {
  assert.deepEqual(problems({ version: 9, grammar: { enabled: 1, language: 'de' }, extra: 1 }), [
    'E102 preferences.checks.version',
    'E102 preferences.checks.grammar.enabled',
    'E102 preferences.checks.grammar.language',
    'E102 preferences.checks.extra',
  ]);
});

test('M13-J02: dialect, words and rules are valid when well formed', () => {
  for (const dialect of ['american', 'british', 'australian', 'canadian', 'indian']) assert.deepEqual(problems({ grammar: { dialect } }), [], dialect);
  assert.deepEqual(problems({ grammar: { words: [] } }), []);
  assert.deepEqual(problems({ grammar: { words: ['Mara', 'Kestrel', "O'Neil", 'x', 'a'.repeat(64), 'Zo\u00eb', 'two words'] } }), []);
  assert.deepEqual(problems({ grammar: { words: Array.from({ length: 5000 }, (_, i) => `w${i}`) } }), []);
  assert.deepEqual(problems({ grammar: { rules: {} } }), []);
  assert.deepEqual(problems({ grammar: { rules: { SpellCheck: false, A: false, ['a' + 'b'.repeat(63)]: false } } }), []);
  assert.deepEqual(problems({ grammar: { enabled: true, language: 'en', dialect: 'british', words: ['Mara'], rules: { SpellCheck: false } } }), []);
});

test('M13-J02: each bad dialect, word and rule is E102 at its exact location', () => {
  assert.deepEqual(problems({ grammar: { dialect: 'klingon' } }), ['E102 preferences.checks.grammar.dialect']);
  assert.deepEqual(problems({ grammar: { dialect: 'British' } }), ['E102 preferences.checks.grammar.dialect']);
  assert.deepEqual(problems({ grammar: { dialect: 1 } }), ['E102 preferences.checks.grammar.dialect']);
  assert.deepEqual(problems({ grammar: { words: 'Mara' } }), ['E102 preferences.checks.grammar.words']);
  assert.deepEqual(problems({ grammar: { words: { a: 1 } } }), ['E102 preferences.checks.grammar.words']);
  assert.deepEqual(problems({ grammar: { words: ['ok', '', 'ok2'] } }), ['E102 preferences.checks.grammar.words.1']);
  assert.deepEqual(problems({ grammar: { words: ['ok', 5] } }), ['E102 preferences.checks.grammar.words.1']);
  assert.deepEqual(problems({ grammar: { words: [' Mara'] } }), ['E102 preferences.checks.grammar.words.0']);
  assert.deepEqual(problems({ grammar: { words: ['Mara '] } }), ['E102 preferences.checks.grammar.words.0']);
  assert.deepEqual(problems({ grammar: { words: ['a\nb'] } }), ['E102 preferences.checks.grammar.words.0']);
  assert.deepEqual(problems({ grammar: { words: ['a\rb'] } }), ['E102 preferences.checks.grammar.words.0']);
  assert.deepEqual(problems({ grammar: { words: ['a'.repeat(65)] } }), ['E102 preferences.checks.grammar.words.0']);
  assert.deepEqual(problems({ grammar: { words: ['Mara', 'Kestrel', 'Mara'] } }), ['E102 preferences.checks.grammar.words.2']);
  assert.deepEqual(problems({ grammar: { words: Array.from({ length: 5001 }, (_, i) => `w${i}`) } }), ['E102 preferences.checks.grammar.words']);
  assert.deepEqual(problems({ grammar: { rules: ['SpellCheck'] } }), ['E102 preferences.checks.grammar.rules']);
  assert.deepEqual(problems({ grammar: { rules: { SpellCheck: true } } }), ['E102 preferences.checks.grammar.rules.SpellCheck']);
  assert.deepEqual(problems({ grammar: { rules: { SpellCheck: 'no' } } }), ['E102 preferences.checks.grammar.rules.SpellCheck']);
  assert.deepEqual(problems({ grammar: { rules: { SpellCheck: null } } }), ['E102 preferences.checks.grammar.rules.SpellCheck']);
  assert.deepEqual(problems({ grammar: { rules: { '1Bad': false } } }), ['E102 preferences.checks.grammar.rules.1Bad']);
  assert.deepEqual(problems({ grammar: { rules: { 'Bad Rule': false } } }), ['E102 preferences.checks.grammar.rules.Bad Rule']);
  assert.deepEqual(problems({ grammar: { rules: { ['a' + 'b'.repeat(64)]: false } } }), ['E102 preferences.checks.grammar.rules.a' + 'b'.repeat(64)]);
  assert.deepEqual(problems({ grammar: { nope: 1 } }), ['E102 preferences.checks.grammar.nope']);
});

test('M13-J02: the dictionary and rules layer like any other setting; grammar is an inspector section before continuity', () => {
  const { values } = resolvePreferences({ library: { checks: { grammar: { words: ['A'], rules: { X: false } } } }, book: { checks: { grammar: { words: ['B'], rules: { Y: false } } } } });
  assert.deepEqual(values.checks.grammar.words, ['B']);
  assert.deepEqual(values.checks.grammar.rules, { X: false, Y: false });
  assert.equal(INSPECTOR_SECTIONS.indexOf('grammar') + 1, INSPECTOR_SECTIONS.indexOf('continuity'));
});
