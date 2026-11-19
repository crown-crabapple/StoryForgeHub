// M13-J01: the `checks` preference (defaults, layering, each E102).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreferences, STYLE_DEFAULTS, STYLE_RULE_IDS, BUILTIN, PROJECT_KEYS, PREFERENCE_KEYS, checkPreferenceMap, preferenceProblems, INSPECTOR_SECTIONS } from '../src/index.mjs';

const DEFAULTS = {
  version: 1,
  grammar: { enabled: false, language: 'en', dialect: 'american', words: [], rules: {} },
  style: { enabled: false, rules: STYLE_DEFAULTS },
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
  assert.deepEqual(values.checks, { version: 1, grammar: { enabled: true, language: 'en', dialect: 'american', words: [], rules: {} }, style: { enabled: false, rules: STYLE_DEFAULTS }, epub: { validate: true } });
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

test('M13-J03: the style defaults are the six rules, deeply frozen, with punctuation unchosen', () => {
  assert.deepEqual(STYLE_RULE_IDS, ['preferred-terms', 'repeated-words', 'punctuation', 'repeated-phrases', 'long-paragraphs', 'isolated-lines']);
  assert.deepEqual(Object.keys(BUILTIN.checks.style.rules), [...STYLE_RULE_IDS]);
  assert.deepEqual(BUILTIN.checks.style.rules, {
    'preferred-terms': { enabled: true, terms: [] },
    'repeated-words': { enabled: true },
    punctuation: { enabled: true, quotes: null, dashes: null, ellipsis: null },
    'repeated-phrases': { enabled: false, minWords: 4, window: 300 },
    'long-paragraphs': { enabled: false, maxWords: 220 },
    'isolated-lines': { enabled: false, minRun: 6 },
  });
  assert.ok(Object.isFrozen(BUILTIN.checks.style.rules));
  for (const id of STYLE_RULE_IDS) assert.ok(Object.isFrozen(BUILTIN.checks.style.rules[id]), id);
  assert.ok(Object.isFrozen(BUILTIN.checks.style.rules['preferred-terms'].terms));
  assert.ok(Object.isFrozen(STYLE_RULE_IDS));
});

test('M13-J03: a well formed checks.style has no problems', () => {
  assert.deepEqual(problems({ style: { enabled: true, rules: STYLE_DEFAULTS } }), []);
  assert.deepEqual(problems({ style: { rules: {} } }), []);
  assert.deepEqual(problems({ style: { rules: { 'preferred-terms': { enabled: true, terms: [{ use: 'grey', avoid: ['gray'] }, { use: 'x', avoid: ['a'.repeat(64), 'b'] }] } } } }), []);
  assert.deepEqual(problems({ style: { rules: { punctuation: { enabled: true, quotes: 'curly', dashes: 'em-spaced', ellipsis: 'dots' } } } }), []);
  assert.deepEqual(problems({ style: { rules: { punctuation: { quotes: 'straight', dashes: 'en-spaced', ellipsis: 'character' } } } }), []);
  assert.deepEqual(problems({ style: { rules: { 'repeated-phrases': { minWords: 3, window: 50 }, 'long-paragraphs': { maxWords: 2000 }, 'isolated-lines': { minRun: 30 } } } }), []);
  assert.deepEqual(problems({ style: { rules: { 'repeated-phrases': { minWords: 8, window: 2000 }, 'long-paragraphs': { maxWords: 50 }, 'isolated-lines': { minRun: 3 } } } }), []);
  assert.deepEqual(problems({ style: { rules: { 'preferred-terms': { terms: Array.from({ length: 500 }, (_, i) => ({ use: `u${i}`, avoid: [`a${i}`] })) } } } }), []);
});

test('M13-J03: each bad checks.style value is E102 at its exact location', () => {
  const R = 'E102 preferences.checks.style.rules';
  assert.deepEqual(problems({ style: { rules: [] } }), [R]);
  assert.deepEqual(problems({ style: { rules: 'all' } }), [R]);
  assert.deepEqual(problems({ style: { rules: { 'textlint-rule-anything': { enabled: true } } } }), [`${R}.textlint-rule-anything`]);
  assert.deepEqual(problems({ style: { rules: { '../x': {} } } }), [`${R}.../x`]);
  assert.deepEqual(problems({ style: { rules: { 'repeated-words': true } } }), [`${R}.repeated-words`]);
  assert.deepEqual(problems({ style: { rules: { 'repeated-words': { enabled: 'yes' } } } }), [`${R}.repeated-words.enabled`]);
  assert.deepEqual(problems({ style: { rules: { 'repeated-words': { minWords: 4 } } } }), [`${R}.repeated-words.minWords`]);
  assert.deepEqual(problems({ style: { rules: { 'long-paragraphs': { minRun: 4 } } } }), [`${R}.long-paragraphs.minRun`]);
  assert.deepEqual(problems({ style: { rules: { punctuation: { quotes: 'fancy' } } } }), [`${R}.punctuation.quotes`]);
  assert.deepEqual(problems({ style: { rules: { punctuation: { dashes: 'em-unspaced' } } } }), [`${R}.punctuation.dashes`]);
  assert.deepEqual(problems({ style: { rules: { punctuation: { ellipsis: 3 } } } }), [`${R}.punctuation.ellipsis`]);
  assert.deepEqual(problems({ style: { rules: { punctuation: { quotes: 'CURLY' } } } }), [`${R}.punctuation.quotes`]);
  for (const [id, key, bad] of [['repeated-phrases', 'minWords', [2, 9, 4.5, '4']], ['repeated-phrases', 'window', [49, 2001, 1.5]], ['long-paragraphs', 'maxWords', [49, 2001, NaN]], ['isolated-lines', 'minRun', [2, 31, 6.1, null]]]) {
    for (const v of bad) assert.deepEqual(problems({ style: { rules: { [id]: { [key]: v } } } }), [`${R}.${id}.${key}`], `${id}.${key}=${String(v)}`);
  }
  const T = `${R}.preferred-terms.terms`;
  const terms = (t) => problems({ style: { rules: { 'preferred-terms': { terms: t } } } });
  assert.deepEqual(terms('grey'), [T]);
  assert.deepEqual(terms(Array.from({ length: 501 }, (_, i) => ({ use: `u${i}`, avoid: [`a${i}`] }))), [T]);
  assert.deepEqual(terms(['grey']), [`${T}.0`]);
  assert.deepEqual(terms([{ use: '', avoid: ['gray'] }]), [`${T}.0.use`]);
  assert.deepEqual(terms([{ use: 'u'.repeat(65), avoid: ['gray'] }]), [`${T}.0.use`]);
  assert.deepEqual(terms([{ use: 'grey' }]), [`${T}.0.avoid`]);
  assert.deepEqual(terms([{ use: 'grey', avoid: [] }]), [`${T}.0.avoid`]);
  assert.deepEqual(terms([{ use: 'grey', avoid: Array.from({ length: 21 }, (_, i) => `a${i}`) }]), [`${T}.0.avoid`]);
  assert.deepEqual(terms([{ use: 'grey', avoid: ['gray', ''] }]), [`${T}.0.avoid.1`]);
  assert.deepEqual(terms([{ use: 'grey', avoid: ['a'.repeat(65)] }]), [`${T}.0.avoid.0`]);
  assert.deepEqual(terms([{ use: 'grey', avoid: ['gray', 'grey'] }]), [`${T}.0.avoid.1`]);
  assert.deepEqual(terms([{ use: 'grey', avoid: ['gray'], extra: 1 }]), [`${T}.0.extra`]);
  assert.deepEqual(problems({ style: { rules: { 'preferred-terms': { caseSensitive: 'no' } } } }), [`${R}.preferred-terms.caseSensitive`]);
});

test('M13-J03: style rules layer rule by rule; a broken style value is ignored by the resolver', () => {
  const { values } = resolvePreferences({ book: { checks: { style: { enabled: true, rules: { punctuation: { quotes: 'curly' } } } } } });
  assert.equal(values.checks.style.enabled, true);
  assert.deepEqual(values.checks.style.rules.punctuation, { enabled: true, quotes: 'curly', dashes: null, ellipsis: null });
  assert.deepEqual(values.checks.style.rules['repeated-words'], { enabled: true });
  const bad = resolvePreferences({ book: { checks: { style: { rules: { evil: { enabled: true } } } } } });
  assert.equal(Object.hasOwn(bad.values.checks.style.rules, 'evil'), false);
  assert.deepEqual(bad.values.checks.style.rules, STYLE_DEFAULTS);
});

test('a preferred term may set caseSensitive (true or false) and nothing else extra', () => {
  const at = (term) => preferenceProblems('checks', { style: { rules: { 'preferred-terms': { enabled: true, terms: [term] } } } });
  assert.deepEqual(at({ use: 'Grey', avoid: ['Gray'], caseSensitive: true }), []);
  assert.ok(at({ use: 'Grey', avoid: ['Gray'], caseSensitive: 'yes' }).some((p) => p.location.endsWith('caseSensitive')));
  assert.ok(at({ use: 'Grey', avoid: ['Gray'], other: 1 }).some((p) => p.location.endsWith('other')));
});
