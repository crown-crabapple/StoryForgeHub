// M13-J05: the `interior` preference (defaults, layering, versioning, each E102 at its exact location).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreferences, BUILTIN, INTERIOR_DEFAULTS, PROJECT_KEYS, PREFERENCE_KEYS, checkPreferenceMap } from '../src/index.mjs';

const EXPECTED = {
  version: 1,
  template: 'novel',
  trim: '6x9',
  font: 'literata',
  fontSize: 11,
  lineHeight: 1.35,
  margins: { inside: 0.75, outside: 0.5, top: 0.6, bottom: 0.6 },
  chapterStart: 'right',
  sceneBreak: 'asterisks',
  runningHeads: true,
  pageNumbers: true,
  frontMatter: { copyright: '', dedication: '' },
  backMatter: { aboutAuthor: '' },
};

const problems = (interior) => checkPreferenceMap({ interior }).map((d) => `${d.code} ${d.location}`);

test('interior is a project key and BUILTIN.interior is exactly the contract map, deeply frozen', () => {
  assert.ok(PROJECT_KEYS.includes('interior'));
  assert.ok(PREFERENCE_KEYS.includes('interior'));
  assert.deepEqual(BUILTIN.interior, EXPECTED);
  assert.deepEqual(INTERIOR_DEFAULTS, EXPECTED);
  assert.ok(Object.isFrozen(BUILTIN.interior));
  assert.ok(Object.isFrozen(BUILTIN.interior.margins));
  assert.ok(Object.isFrozen(BUILTIN.interior.frontMatter));
  assert.ok(Object.isFrozen(BUILTIN.interior.backMatter));
});

test('the defaults and partial maps are valid', () => {
  assert.deepEqual(problems(EXPECTED), []);
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ version: 1, trim: '5.5x8.5', font: 'inter', fontSize: 9.5, lineHeight: 1.8, margins: { inside: 1.5, top: 0.25 }, chapterStart: 'any', sceneBreak: 'blank', runningHeads: false, pageNumbers: false }), []);
  assert.deepEqual(problems({ frontMatter: { copyright: 'x'.repeat(2000), dedication: 'y'.repeat(1000) }, backMatter: { aboutAuthor: 'z'.repeat(4000) } }), []);
});

test('layering: built-in < profile < library < book, margins merge key by key', () => {
  const { values, sources } = resolvePreferences({
    profile: { interior: { font: 'inter', trim: '5.5x8.5' } },
    library: { interior: { trim: '6x9' } },
    book: { interior: { margins: { inside: 1 }, frontMatter: { dedication: 'For Ilse.' } } },
  });
  assert.deepEqual(values.interior, { ...EXPECTED, font: 'inter', margins: { ...EXPECTED.margins, inside: 1 }, frontMatter: { copyright: '', dedication: 'For Ilse.' } });
  assert.equal(sources['interior.font'], 'profile');
  assert.equal(sources['interior.trim'], 'library');
  assert.equal(sources['interior.margins.inside'], 'book');
  assert.equal(sources['interior.margins.top'], 'builtin');
  const none = resolvePreferences({});
  assert.deepEqual(none.values.interior, EXPECTED);
});

test('a broken interior value is ignored by the resolver, the good parts are kept', () => {
  const { values } = resolvePreferences({ book: { interior: { trim: 'a4', font: 'inter' } } });
  assert.equal(values.interior.font, 'inter');
  assert.equal(values.interior.trim, '6x9');
});

test('version other than 1 is E102 (saved by a newer StoryForge)', () => {
  assert.deepEqual(problems({ version: 2 }), ['E102 preferences.interior.version']);
  assert.deepEqual(problems({ version: '1' }), ['E102 preferences.interior.version']);
  const [d] = checkPreferenceMap({ interior: { version: 2 } });
  assert.match(d.message, /newer StoryForge/);
});

test('each refusal is E102 at the exact location', () => {
  const cases = [
    [{ template: 'thriller' }, 'template'],
    [{ trim: '8x10' }, 'trim'],
    [{ font: 'comic' }, 'font'],
    [{ fontSize: 8.5 }, 'fontSize'],
    [{ fontSize: 14.5 }, 'fontSize'],
    [{ fontSize: 11.3 }, 'fontSize'],
    [{ fontSize: '11' }, 'fontSize'],
    [{ lineHeight: 1.0 }, 'lineHeight'],
    [{ lineHeight: 1.9 }, 'lineHeight'],
    [{ lineHeight: null }, 'lineHeight'],
    [{ margins: { inside: 0.2 } }, 'margins.inside'],
    [{ margins: { outside: 1.6 } }, 'margins.outside'],
    [{ margins: { top: '0.5' } }, 'margins.top'],
    [{ margins: { bottom: Number.NaN } }, 'margins.bottom'],
    [{ margins: { left: 0.5 } }, 'margins.left'],
    [{ margins: [] }, 'margins'],
    [{ chapterStart: 'left' }, 'chapterStart'],
    [{ sceneBreak: 'line' }, 'sceneBreak'],
    [{ runningHeads: 'yes' }, 'runningHeads'],
    [{ pageNumbers: 1 }, 'pageNumbers'],
    [{ frontMatter: { copyright: 'x'.repeat(2001) } }, 'frontMatter.copyright'],
    [{ frontMatter: { dedication: 'y'.repeat(1001) } }, 'frontMatter.dedication'],
    [{ frontMatter: { dedication: 5 } }, 'frontMatter.dedication'],
    [{ frontMatter: { epigraph: 'x' } }, 'frontMatter.epigraph'],
    [{ frontMatter: 'x' }, 'frontMatter'],
    [{ backMatter: { aboutAuthor: 'z'.repeat(4001) } }, 'backMatter.aboutAuthor'],
    [{ backMatter: { thanks: 'x' } }, 'backMatter.thanks'],
    [{ backMatter: null }, 'backMatter'],
    [{ colour: 'red' }, 'colour'],
  ];
  for (const [value, loc] of cases) assert.deepEqual(problems(value), [`E102 preferences.interior.${loc}`], JSON.stringify(value).slice(0, 80));
  assert.deepEqual(problems('novel'), ['E102 preferences.interior']);
  assert.deepEqual(problems([]), ['E102 preferences.interior']);
  assert.deepEqual(problems({ trim: 'x', font: 'y' }), ['E102 preferences.interior.trim', 'E102 preferences.interior.font']);
});
