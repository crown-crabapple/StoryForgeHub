// M04-J04 acceptance 1: event `date`, absolute local links (E103), http(s) links, research `links` / `sources`.
// Contract: docs/contracts/M04-J04-timeline-research.md section 1. Each case edits a temp copy of valid/salt-orchard
// and compares the diagnostics with the untouched copy's, so only what the case adds is asserted on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-j04t-'));
  const dest = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), dest, { recursive: true });
  return dest;
}
const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
const put = (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const EVENT = 'planning/timeline/the-tide-turns.md';
const event = (extra) => `---
schema: storyforge.event/v1
id: event_01S5000000000000000000AA01
slug: the-tide-turns
title: The tide turns
order: 120
${extra}---
Text.
`;
const NOTE = 'research/links-note.md';
const note = (extra, body = 'Text.\n') => `---
schema: storyforge.research/v1
id: note_01S5000000000000000000AA02
title: Links note
${extra}---
${body}`;

/** Diagnostics added by `edit` relative to an untouched copy. */
async function added(edit) {
  const root = copy();
  const base = keys(await validate(root));
  await edit(root);
  const now = keys(await validate(root));
  return { added: now.filter((k) => !base.includes(k)), removed: base.filter((k) => !now.includes(k)), all: now, base };
}

// ---------------------------------------------------------------- event date

for (const [label, line] of [
  ['absent', ''],
  ['empty string', 'date: ""\n'],
  ['year', 'date: "1998"\n'],
  ['year-month', 'date: "1998-07"\n'],
  ['full date', 'date: "1998-07-21"\n'],
  ['full date, unquoted (a YAML 1.2 string)', 'date: 1998-07-21\n'],
]) {
  test(`event date ${label}: no diagnostics`, async () => {
    const r = await added((root) => put(root, EVENT, event(line)));
    assert.deepEqual(r.added, []);
  });
}

for (const bad of ['"spring"', '"1998-13"', '"1998-00"', '"1998-7"', '"98"', '"1998-07-32"', '"1998-07-00"', '"1998/07/21"', '"1998-07-21T10:00"', '" 1998"', '"12345"', '[1998]']) {
  test(`event date ${bad}: exactly one E102 at date`, async () => {
    const r = await added((root) => put(root, EVENT, event(`date: ${bad}\n`)));
    assert.deepEqual(r.added, [`E102 | ${EVENT} | date`]);
  });
}

test('events with an identical order are allowed (simultaneous)', async () => {
  const r = await added((root) => put(root, EVENT, event('').replace('order: 120', 'order: 100')));
  assert.deepEqual(r.added, []);
});

test('event order must still be a finite number', async () => {
  const r = await added((root) => put(root, EVENT, event('').replace('order: 120', 'order: soon')));
  assert.deepEqual(r.added, [`E102 | ${EVENT} | order`]);
});

// ---------------------------------------------------------------- absolute links

const noteAt = (body) => (root) => put(root, NOTE, note('', body));

for (const target of ['C:\\maps\\coast.pdf', 'C:/maps/coast.pdf', 'c:\\maps\\coast.pdf', '/maps/coast.pdf', 'file:///tmp/coast.pdf', 'file://C:/maps/coast.pdf']) {
  test(`absolute local link ${target}: one E103, no E301`, async () => {
    const r = await added(noteAt(`See the [chart](${target}).\n`));
    assert.equal(r.added.length, 1, r.added.join('; '));
    assert.match(r.added[0], new RegExp(`^E103 \\| ${NOTE} \\| line \\d+$`));
  });
}

test('absolute link in a scene body is E103 too (rule applies to every Markdown file)', async () => {
  const f = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry.md';
  const r = await added((root) => fs.appendFileSync(path.join(root, ...f.split('/')), '\nSee [chart](/maps/coast.pdf).\n'));
  assert.equal(r.added.length, 1, r.added.join('; '));
  assert.match(r.added[0], new RegExp(`^E103 \\| ${f} \\| line \\d+$`));
});

for (const target of ['http://example.com/a.pdf', 'https://example.com/a/b?c=d#e', 'HTTPS://EXAMPLE.COM/x', 'https://example.com/no-such-file.pdf', 'mailto:a@example.com']) {
  test(`external link ${target} is never checked`, async () => {
    const r = await added(noteAt(`See [the source](${target}) and <${target}>.\n`));
    assert.deepEqual(r.added, []);
  });
}

test('an http link on the same line as nothing else leaves every existing diagnostic in place', async () => {
  const r = await added(noteAt('[a](https://example.com)\n'));
  assert.deepEqual(r.removed, []);
});

test('relative attachment link that resolves: clean; missing: E301; escaping the book: E103', async () => {
  const ok = await added((root) => {
    put(root, 'assets/research/map.pdf', '%PDF-1.4\n');
    put(root, NOTE, note('', 'The [map](../assets/research/map.pdf).\n'));
  });
  assert.deepEqual(ok.added, []);

  const missing = await added(noteAt('The [map](../assets/research/none.pdf).\n'));
  assert.equal(missing.added.length, 1);
  assert.match(missing.added[0], new RegExp(`^E301 \\| ${NOTE} \\| line \\d+$`));

  const escape = await added(noteAt('The [map](../../outside.pdf).\n'));
  assert.equal(escape.added.length, 1);
  assert.match(escape.added[0], new RegExp(`^E103 \\| ${NOTE} \\| line \\d+$`));
});

test('a link written relative to the book root instead of the note is E301 (links resolve from the containing file)', async () => {
  const r = await added((root) => {
    put(root, 'assets/research/map.pdf', '%PDF-1.4\n');
    put(root, NOTE, note('', 'The [map](assets/research/map.pdf).\n'));
  });
  assert.equal(r.added.length, 1);
  assert.match(r.added[0], /^E301 /);
});

// ---------------------------------------------------------------- research links / sources

for (const [label, line] of [
  ['an entry', 'links: [maren-hollis]'],
  ['a thread', 'links: [brass-key]'],
  ['an event', 'links: [the-flood]'],
  ['all three kinds', 'links: [maren-hollis, brass-key, the-flood]'],
  ['an empty list', 'links: []'],
]) {
  test(`research links to ${label}: clean`, async () => {
    const r = await added((root) => put(root, NOTE, note(`${line}\n`)));
    assert.deepEqual(r.added, []);
  });
}

test('research links naming nothing: E301 at links[i] for the right index only', async () => {
  const r = await added((root) => put(root, NOTE, note('links: [maren-hollis, nobody-here]\n')));
  assert.deepEqual(r.added, [`E301 | ${NOTE} | links[1]`]);
});

test('research sources naming an existing cite_key: clean', async () => {
  const r = await added((root) => put(root, NOTE, note('sources: [admiralty-tables]\n')));
  assert.deepEqual(r.added, []);
});

test('research sources naming nothing: E301 at sources[i]', async () => {
  const r = await added((root) => put(root, NOTE, note('sources: [admiralty-tables, no-such-source, other-missing]\n')));
  assert.deepEqual(r.added, [`E301 | ${NOTE} | sources[1]`, `E301 | ${NOTE} | sources[2]`]);
});

test('research sources must be a cite_key, not an entry slug', async () => {
  const r = await added((root) => put(root, NOTE, note('sources: [maren-hollis]\n')));
  assert.deepEqual(r.added, [`E301 | ${NOTE} | sources[0]`]);
});
