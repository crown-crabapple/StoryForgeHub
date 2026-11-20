// P2-J2: the chapter document (build / split round trip, dirty detection) and the scene guard (transaction filter, boundary keys), headless with ProseMirror state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { docToMarkdown } from '@storyforge/format/rich';
import { authorNotesByScene, buildChapterDoc, changedScenes, editedSceneIds, replaceSceneTransaction, sceneAt, sceneSlices, splitChapterDoc } from '../src/chapter/chapter-doc.js';
import { atSceneEnd, atSceneStart, chapterStillValid, sceneGuardKey, sceneGuardPlugin } from '../src/chapter/scene-guard.js';
import { chapterExtensions } from '../src/chapter/schema.js';

const schema = getSchema(chapterExtensions);

const BODIES = [
  '',
  '\n',
  'Plain.\n',
  'One paragraph with *italic*, **bold**, `code` and a [link](https://example.org/x).\n\nSecond paragraph.\n',
  '\n\nLeading blank lines and a trailing run.\n\n\n',
  '## Heading two\n\nText\n\n### Three\n\n#### Four\n',
  '> A quoted line\n> and another\n\nAfter.\n',
  '- one\n- two\n- three\n\n1. first\n2. second\n',
  'Line one\nline two inside the paragraph.\n',
  'Before\n\n***\n\nAfter\n',
  'A note <!-- note: remember the key --> in the text, and a cite [@smith2020].\n',
  'Mention [[maren-hollis]] and [[maren-hollis|Maren]] here.\n',
  'Raw: <!-- sf:anchor x --> and ![img](a.png) kept.\n',
  '```\ncode fence\n\nwith a blank line\n```\n\nAfter fence\n',
  'Windows line endings.\r\n\r\nSecond.\r\n',
  'Mixed\r\nendings\nhere.\n',
  'Three blank lines between\n\n\n\nblocks.\n',
  '__under__ and ~~strike~~ and a literal * star and 1. not a list\n',
];

const scene = (i, body, extra = {}) => ({ id: `scene_${i}`, title: `Scene ${i}`, body, ...extra });
const toNode = (json) => schema.nodeFromJSON(json);

test('every body: build -> ProseMirror -> split -> Markdown gives the body back byte for byte', () => {
  for (const body of BODIES) {
    const chapter = toNode(buildChapterDoc([scene(1, body)]));
    chapter.check();
    const [only] = splitChapterDoc(chapter);
    assert.equal(only.sceneId, 'scene_1');
    assert.equal(docToMarkdown(only.doc), body, JSON.stringify(body));
  }
});

test('several scenes in one chapter each come back as their own body', () => {
  const scenes = BODIES.map((b, i) => scene(i, b));
  const chapter = toNode(buildChapterDoc(scenes));
  chapter.check();
  const parts = splitChapterDoc(chapter);
  assert.deepEqual(
    parts.map((p) => p.sceneId),
    scenes.map((s) => s.id),
  );
  parts.forEach((p, i) => {
    if (!p.doc.attrs.readOnly) assert.equal(docToMarkdown(p.doc), scenes[i].body, JSON.stringify(scenes[i].body));
  });
});

test('splitChapterDoc takes JSON or a node, and `only` restricts the scenes', () => {
  const json = buildChapterDoc([scene(1, 'A\n'), scene(2, 'B\n'), scene(3, 'C\n')]);
  assert.equal(splitChapterDoc(json).length, 3);
  assert.equal(splitChapterDoc(toNode(json)).length, 3);
  assert.deepEqual(splitChapterDoc(json, { only: ['scene_2'] }).map((p) => p.sceneId), ['scene_2']);
});

test('a scene with no blocks still exists, as an empty paragraph, and typing into it writes the text', () => {
  const json = buildChapterDoc([scene(1, ''), scene(2, 'Next\n')]);
  const sliceCount = sceneSlices(toNode(json));
  assert.equal(sliceCount.length, 2);
  assert.equal(sliceCount[0].blocks.length, 1);
  assert.equal(sliceCount[0].blocks[0].type.name, 'paragraph');
  const state = EditorState.create({ schema, doc: toNode(json) });
  const at = sliceCount[0].from + 1;
  const typed = state.apply(state.tr.insertText('Hello', at));
  const [first] = splitChapterDoc(typed.doc);
  assert.equal(docToMarkdown(first.doc), 'Hello');
});

test('the scene break carries the scene doc attrs (lead, trail, eol) and the id', () => {
  const chapter = toNode(buildChapterDoc([scene(1, '\n\nBody\r\n\r\nMore\r\n\n')]));
  const brk = chapter.child(0);
  assert.equal(brk.type.name, 'sceneBreak');
  assert.equal(brk.attrs.sceneId, 'scene_1');
  assert.equal(brk.attrs.title, 'Scene 1');
  assert.equal(brk.attrs.readOnly, true, 'mixed endings are read-only');
  const crlf = toNode(buildChapterDoc([scene(1, '\r\n\r\nBody\r\n\r\nMore\r\n')])).child(0);
  assert.equal(crlf.attrs.eol, 'crlf');
  assert.equal(crlf.attrs.lead, '\n\n');
});

test('read-only scenes: problem, raw, failed and mixed line endings show their text in a rawBlock and are not split as editable', () => {
  const doc = buildChapterDoc([
    scene(1, 'bad: [file\n', { problem: { code: 'X', message: 'm' } }),
    scene(2, '---\nraw\n---\n', { raw: true }),
    { id: 'scene_3', title: 'Gone', failed: true },
    scene(4, 'a\r\nb\nc\n'),
  ]);
  const chapter = toNode(doc);
  chapter.check();
  const slices = sceneSlices(chapter);
  assert.deepEqual(
    slices.map((s) => [s.node.attrs.readOnly, s.node.attrs.reason]),
    [
      [true, 'problem'],
      [true, 'raw'],
      [true, 'failed'],
      [true, 'mixed'],
    ],
  );
  assert.ok(slices.every((s) => s.blocks.length === 1 && s.blocks[0].type.name === 'rawBlock'));
  assert.equal(slices[0].blocks[0].attrs.text, 'bad: [file\n');
  assert.ok(splitChapterDoc(chapter).every((p) => p.doc.attrs.readOnly === true));
});

test('the schema has exactly the converter names: unknown content is rejected, list items hold one paragraph, headings have no line break', () => {
  assert.throws(() => toNode({ type: 'doc', content: [{ type: 'codeBlock' }] }));
  const nested = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] }] };
  assert.throws(() => toNode({ type: 'doc', content: [{ type: 'sceneBreak', attrs: { sceneId: 'a' } }, nested] }).check());
  const hardInHeading = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'hardBreak', attrs: { soft: true } }] };
  assert.throws(() => toNode({ type: 'doc', content: [{ type: 'sceneBreak', attrs: { sceneId: 'a' } }, hardInHeading] }).check());
  const level5 = { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'x' }] };
  assert.ok(toNode({ type: 'doc', content: [{ type: 'sceneBreak', attrs: { sceneId: 'a' } }, level5] }), 'level is just an attr; the converter never produces 5');
});

// ------------------------------------------------------------------ dirty detection

test('changedScenes: an unedited scene is never reported, an edited one is, with its Markdown', () => {
  const scenes = [scene(1, 'Alpha\n\nBeta\n'), scene(2, '*Gamma*\n'), scene(3, 'Delta\n')];
  const known = new Map(scenes.map((s) => [s.id, s.body]));
  const chapter = toNode(buildChapterDoc(scenes));
  assert.deepEqual(changedScenes(known, splitChapterDoc(chapter)), { changed: [], failed: [] });
  const second = sceneSlices(chapter)[1];
  const state = EditorState.create({ schema, doc: chapter });
  const edited = state.apply(state.tr.insertText('!', second.from + 2)); // inside "Gamma"
  const { changed, failed } = changedScenes(known, splitChapterDoc(edited.doc));
  assert.deepEqual(failed, []);
  assert.deepEqual(changed.map((c) => c.sceneId), ['scene_2']);
  assert.equal(changed[0].markdown, '*G!amma*\n');
  // typing it and taking it away again is "unchanged" again
  const back = edited.apply(edited.tr.delete(second.from + 2, second.from + 3));
  assert.deepEqual(changedScenes(known, splitChapterDoc(back.doc)).changed, []);
});

test('changedScenes: read-only scenes and unknown scenes are skipped; a scene that cannot be written is listed as failed, never as changed', () => {
  const chapter = toNode(buildChapterDoc([scene(1, 'a\r\nb\nc\n'), scene(2, 'fine\n')]));
  const known = { scene_1: 'a\r\nb\nc\n', scene_2: 'fine\n' };
  assert.deepEqual(changedScenes(known, splitChapterDoc(chapter)), { changed: [], failed: [] });
  assert.deepEqual(changedScenes({}, splitChapterDoc(chapter)), { changed: [], failed: [] });
  // a link whose address has a space cannot be written as Markdown
  const state = EditorState.create({ schema, doc: chapter });
  const s2 = sceneSlices(chapter)[1];
  const link = schema.marks.link.create({ href: 'not valid' });
  const bad = state.apply(state.tr.addMark(s2.from + 1, s2.from + 3, link));
  const r = changedScenes(known, splitChapterDoc(bad.doc));
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.failed.map((f) => f.sceneId), ['scene_2']);
  assert.match(r.failed[0].error, /link/);
});

test('editedSceneIds: ProseMirror shares unchanged scenes, so only the edited one is serialised again', () => {
  const chapter = toNode(buildChapterDoc([scene(1, 'A\n'), scene(2, 'B\n'), scene(3, 'C\n')]));
  const state = EditorState.create({ schema, doc: chapter });
  const before = sceneSlices(chapter);
  assert.deepEqual(editedSceneIds(before, sceneSlices(chapter)), []);
  const next = state.apply(state.tr.insertText('x', before[2].from + 1));
  assert.deepEqual(editedSceneIds(before, sceneSlices(next.doc)), ['scene_3']);
});

test('replaceSceneTransaction swaps one scene for a Markdown text and leaves the others', () => {
  const chapter = toNode(buildChapterDoc([scene(1, 'A\n'), scene(2, 'B\n\nBB\n'), scene(3, 'C\n')]));
  const state = EditorState.create({ schema, doc: chapter, plugins: [sceneGuardPlugin()] });
  const tr = replaceSceneTransaction(state, 'scene_2', '\nNew *text*\n');
  const next = state.apply(tr);
  const parts = splitChapterDoc(next.doc);
  assert.deepEqual(parts.map((p) => docToMarkdown(p.doc)), ['A\n', '\nNew *text*\n', 'C\n']);
  assert.equal(replaceSceneTransaction(state, 'missing', 'x'), null);
});

test('authorNotesByScene and sceneAt', () => {
  const chapter = toNode(buildChapterDoc([scene(1, 'No notes\n'), scene(2, 'One <!-- note: first --> and <!-- note: second -->\n')]));
  const notes = authorNotesByScene(chapter);
  assert.deepEqual(notes.get('scene_1'), []);
  assert.deepEqual(notes.get('scene_2').map((n) => n.text), ['first', 'second']);
  assert.equal(chapter.nodeAt(notes.get('scene_2')[0].pos).type.name, 'authorNote');
  const slices = sceneSlices(chapter);
  assert.equal(sceneAt(chapter, slices[0].from + 2), 'scene_1');
  assert.equal(sceneAt(chapter, slices[1].from + 2), 'scene_2');
});

// ------------------------------------------------------------------ the scene guard

const guarded = () => {
  const chapter = toNode(buildChapterDoc([scene(1, 'First scene\n\nSecond block\n'), scene(2, 'Next scene\n'), scene(3, 'Last\n')]));
  return EditorState.create({ schema, doc: chapter, plugins: [sceneGuardPlugin()] });
};
const at = (state, pos) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
const idsOf = (doc) => sceneSlices(doc).map((s) => s.sceneId);

test('guard: ordinary typing and deleting inside a scene is applied', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const next = state.apply(state.tr.insertText('Hi ', s[1].from + 1));
  assert.notEqual(next.doc, state.doc);
  const del = next.apply(next.tr.delete(s[1].from + 1, s[1].from + 4));
  assert.equal(del.doc.textContent, state.doc.textContent);
});

test('guard: a transaction that removes a scene break is rejected, whole', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const { state: after, transactions } = state.applyTransaction(state.tr.delete(s[1].breakPos, s[1].from));
  assert.equal(after.doc, state.doc);
  assert.equal(transactions.length, 0);
  // a selection that runs from the middle of one scene into the next, removed
  const across = state.applyTransaction(state.tr.delete(s[0].from + 3, s[1].from + 3));
  assert.equal(across.state.doc, state.doc);
});

test('guard: a transaction that merges scenes by deleting the break and the text around it is rejected', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const r = state.applyTransaction(state.tr.delete(s[0].to - 1, s[1].from + 1));
  assert.equal(r.state.doc, state.doc);
});

test('guard: a transaction that adds, duplicates or reorders breaks is rejected', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const dup = state.applyTransaction(state.tr.insert(s[0].to, schema.nodes.sceneBreak.create({ sceneId: 'scene_9' })));
  assert.equal(dup.state.doc, state.doc);
  const copy = state.applyTransaction(state.tr.insert(s[2].to, s[0].node));
  assert.equal(copy.state.doc, state.doc);
  // move scene 1's blocks and break after scene 2: the ids come out in another order
  const moved = state.tr;
  moved.delete(s[0].breakPos, s[0].to);
  moved.insert(moved.mapping.map(s[1].to), [s[0].node, ...s[0].blocks]);
  assert.equal(state.applyTransaction(moved).state.doc, state.doc);
});

test('guard: a scene may not be emptied of all its blocks', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const tr = state.tr.delete(s[1].from, s[1].to);
  assert.equal(chapterStillValid(state.doc, tr.doc), false);
  assert.equal(state.applyTransaction(tr).state.doc, state.doc);
});

test('guard: a break may change its attrs (a title) but not move', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const tr = state.tr.setNodeMarkup(s[1].breakPos, undefined, { ...s[1].node.attrs, title: 'Renamed' });
  const next = state.apply(tr);
  assert.equal(sceneSlices(next.doc)[1].node.attrs.title, 'Renamed');
  assert.deepEqual(idsOf(next.doc), ['scene_1', 'scene_2', 'scene_3']);
});

test('guard: a read-only scene cannot be changed', () => {
  const chapter = toNode(buildChapterDoc([scene(1, 'Fine\n'), scene(2, 'bad\n', { problem: { code: 'X', message: 'm' } })]));
  const state = EditorState.create({ schema, doc: chapter, plugins: [sceneGuardPlugin()] });
  const s = sceneSlices(chapter);
  const r = state.applyTransaction(state.tr.replaceWith(s[1].from, s[1].to, schema.nodes.paragraph.create()));
  assert.equal(r.state.doc, state.doc);
  assert.notEqual(state.apply(state.tr.insertText('x', s[0].from + 1)).doc, state.doc);
});

test('guard: a program load marked allow passes', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  const tr = state.tr.delete(s[2].breakPos, s[2].to).setMeta(sceneGuardKey, 'allow');
  const next = state.applyTransaction(tr).state;
  assert.deepEqual(idsOf(next.doc), ['scene_1', 'scene_2']);
});

test('boundary keys: Backspace at the start of a scene and Delete at its end are caught, elsewhere they are not', () => {
  const state = guarded();
  const s = sceneSlices(state.doc);
  assert.equal(atSceneStart(at(state, s[1].from + 1)), true, 'start of scene 2');
  assert.equal(atSceneStart(at(state, s[0].from + 1)), true, 'start of scene 1');
  assert.equal(atSceneStart(at(state, s[1].from + 3)), false, 'inside the text');
  assert.equal(atSceneStart(at(state, s[0].blocks[0].nodeSize + s[0].from + 1)), false, 'start of the second block is not a scene start');
  assert.equal(atSceneEnd(at(state, s[0].to - 1)), true, 'end of scene 1');
  assert.equal(atSceneEnd(at(state, s[0].from + 1 + s[0].blocks[0].nodeSize - 1)), false, 'end of its first block');
  assert.equal(atSceneEnd(at(state, s[2].to - 1)), false, 'end of the last scene: nothing follows');
  assert.equal(atSceneEnd(at(state, s[1].from + 2)), false);
});

test('boundary keys: first and last blocks that are lists or quotes count too', () => {
  const chapter = toNode(buildChapterDoc([scene(1, '- one\n- two\n'), scene(2, '> quoted\n'), scene(3, 'x\n')]));
  const state = EditorState.create({ schema, doc: chapter });
  const s = sceneSlices(chapter);
  // start of the first list item of scene 1: list(1) > item(1) > paragraph(1) -> content at from + 3
  assert.equal(atSceneStart(at(state, s[0].from + 3)), true);
  // start of the second item is not a scene start
  const secondItem = s[0].from + 1 + chapter.child(1).child(0).nodeSize + 2;
  assert.equal(atSceneStart(at(state, secondItem)), false);
  // end of the last item of scene 1
  assert.equal(atSceneEnd(at(state, s[0].to - 3)), true);
  assert.equal(atSceneEnd(at(state, s[1].to - 2)), true, 'end of the quote that closes scene 2');
});
