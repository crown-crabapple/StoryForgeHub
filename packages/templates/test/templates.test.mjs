// M02-J03 acceptance 8 (templates are documented) plus rendering checks for each template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { listTemplates, renderTemplate } from '../src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(here, '..', 'templates');
const NAMES = ['blank', 'story-circle', 'heros-journey', 'seven-point'];
const SHAPE = {
  blank: { acts: 1, chapters: 1, scenes: 1 },
  'story-circle': { acts: 2, chapters: 8, scenes: 8 },
  'heros-journey': { acts: 3, chapters: 12, scenes: 12 },
  'seven-point': { acts: 3, chapters: 7, scenes: 7 },
};
const VARS = { book_title: 'The Test Book', book_slug: 'the-test-book', pen_name: 'r-fenwick', today: '2026-01-02' };

/** Split `---` front matter from the body with plain string handling (no format package). */
function split(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return { fm: null, body: text };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { fm: null, body: text };
  return { fm: YAML.parse(lines.slice(1, end).join('\n')), body: lines.slice(end + 1).join('\n') };
}

const render = async (name) => renderTemplate(name, { ...VARS });
const asText = (buf) => Buffer.from(buf).toString('utf8');

test('listTemplates lists exactly blank, story-circle, heros-journey, seven-point with the documented shape', async () => {
  const list = await listTemplates();
  assert.deepEqual(list.map((t) => t.name).sort(), [...NAMES].sort());
  for (const t of list) {
    assert.equal(typeof t.title, 'string');
    assert.ok(t.title.length > 0, `${t.name} title`);
    assert.ok(t.description.length > 0, `${t.name} description`);
    assert.ok(Array.isArray(t.beats) && t.beats.length > 0, `${t.name} beats`);
    assert.deepEqual({ acts: t.acts, chapters: t.chapters, scenes: t.scenes }, SHAPE[t.name], `${t.name} counts`);
  }
});

test('the beat lists have the contract sizes', async () => {
  const by = Object.fromEntries((await listTemplates()).map((t) => [t.name, t]));
  assert.equal(by['story-circle'].beats.length, 8);
  assert.equal(by['heros-journey'].beats.length, 12);
  assert.equal(by['seven-point'].beats.length, 7);
});

for (const name of NAMES) {
  test(`${name}: template.md validates against its own schema and planning/plan.md exists`, async () => {
    const dir = path.join(TEMPLATES_DIR, name);
    const { fm, body } = split(await fs.readFile(path.join(dir, 'template.md'), 'utf8'));
    assert.ok(fm, 'template.md has front matter');
    assert.equal(fm.schema, 'storyforge.template/v1');
    assert.equal(fm.name, name, 'name matches the folder');
    assert.equal(typeof fm.title, 'string');
    assert.ok(fm.title.trim().length > 0, 'title');
    assert.equal(typeof fm.description, 'string');
    assert.ok(fm.description.trim().length > 0, 'description');
    assert.ok(Array.isArray(fm.beats) && fm.beats.length > 0, 'beats non-empty list');
    for (const b of fm.beats) assert.ok(typeof b === 'string' ? b.trim().length > 0 : b && typeof b === 'object', 'each beat has content');
    const source = typeof fm.source === 'string' ? fm.source : body;
    assert.ok(source.trim().length > 0, 'a source / attribution note is present');

    const plan = await fs.readFile(path.join(dir, 'book', 'planning', 'plan.md'), 'utf8');
    assert.ok(plan.trim().length > 0, 'plan.md is not empty');
  });

  test(`${name}: listTemplates agrees with template.md`, async () => {
    const { fm } = split(await fs.readFile(path.join(TEMPLATES_DIR, name, 'template.md'), 'utf8'));
    const t = (await listTemplates()).find((x) => x.name === name);
    assert.equal(t.title, fm.title);
    assert.equal(t.description, fm.description);
    assert.equal(t.beats.length, fm.beats.length);
  });

  test(`${name}: renders to a Map of relative paths with no placeholder left`, async () => {
    const files = await render(name);
    assert.ok(files instanceof Map);
    for (const rel of ['book.md', 'planning/plan.md']) assert.ok(files.has(rel), `has ${rel}`);
    for (const [rel, buf] of files) {
      assert.ok(Buffer.isBuffer(buf), `${rel} is a Buffer`);
      assert.ok(!path.isAbsolute(rel) && !rel.startsWith('/') && !rel.split('/').includes('..') && !rel.includes('\\'), `${rel} is a clean relative path`);
      assert.ok(!asText(buf).includes('{{'), `${rel} still has {{`);
      assert.ok(!asText(buf).includes('}}'), `${rel} still has }}`);
      assert.ok(!rel.includes('{{'), `${rel}: path has a placeholder`);
    }
    // template.md is documentation, it does not become part of the book
    assert.ok(!files.has('template.md'));
  });

  test(`${name}: book.md carries the title and slug, scene count and statuses match, ids are unique and well-formed`, async () => {
    const files = await render(name);
    const book = split(asText(files.get('book.md'))).fm;
    assert.equal(book.schema, 'storyforge.book/v1');
    assert.equal(book.title, VARS.book_title);
    assert.equal(book.slug, VARS.book_slug);
    assert.match(book.id, /^book_[0-9A-HJKMNP-TV-Z]{26}$/);

    const scenes = [];
    const ids = [];
    for (const [rel, buf] of files) {
      if (!rel.endsWith('.md')) continue;
      const { fm, body } = split(asText(buf));
      if (!fm) continue;
      ids.push(fm.id);
      assert.match(fm.id, /^(book|act|chap|scene|note)_[0-9A-HJKMNP-TV-Z]{26}$/, `${rel} id`);
      if (fm.schema === 'storyforge.scene/v1') scenes.push({ rel, fm, body });
    }
    assert.equal(new Set(ids).size, ids.length, 'ids unique inside one render');
    assert.equal(scenes.length, SHAPE[name].scenes);
    for (const s of scenes) assert.ok(s.rel.startsWith('manuscript/act-'), s.rel);
    if (name === 'blank') {
      assert.equal(scenes[0].fm.title, 'Untitled scene');
      assert.equal(scenes[0].fm.status, 'drafting');
      assert.equal(scenes[0].body.trim(), '');
    } else {
      for (const s of scenes) {
        assert.equal(s.fm.status, 'outline', s.rel);
        assert.ok(typeof s.fm.summary === 'string' && s.fm.summary.trim().length > 0, `${s.rel} has a summary`);
        assert.ok(s.body.trim().length > 0, `${s.rel} has a one-line prompt`);
      }
    }
  });

  test(`${name}: two renders share no ids (every id is fresh each time)`, async () => {
    const idsOf = (files) => {
      const out = new Set();
      for (const [rel, buf] of files) {
        if (!rel.endsWith('.md')) continue;
        const { fm } = split(asText(buf));
        if (fm?.id) out.add(fm.id);
      }
      return out;
    };
    const a = idsOf(await render(name));
    const b = idsOf(await render(name));
    assert.ok(a.size > 0);
    for (const id of a) assert.ok(!b.has(id), `${id} reused`);
  });
}
