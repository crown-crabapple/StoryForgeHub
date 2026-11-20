// A chapter as one editor document, and back. Pure: no DOM, no React, runs under `node --test`.
//
// Each scene is its own Markdown document (packages/format/src/rich.mjs). The chapter document is a `sceneBreak` node before the blocks of each scene; the scene's
// own document attrs (lead, trail, eol, readOnly) ride on its sceneBreak so every scene writes back exactly as it was read. Nothing here saves a scene whose
// Markdown did not change: that is decided by comparing what the scene serialises to against the text already held for it (`changedScenes`).
import { docToMarkdown, markdownToDoc, RichSerializeError } from '@storyforge/format/rich';

const EMPTY_PARAGRAPH = { type: 'paragraph' };

/**
 * Why a scene cannot be edited here, or null. `scene` is the GET scene answer: `problem` (the file cannot be read), `raw` (shown as the raw file), or no answer at all (`failed`).
 * @param {any} scene @param {any} [converted] the markdownToDoc result @returns {'failed' | 'problem' | 'raw' | 'mixed' | null}
 */
export function readOnlyReason(scene, converted) {
  if (!scene || scene.failed || typeof scene.body !== 'string') return 'failed';
  if (scene.problem) return 'problem';
  if (scene.raw) return 'raw';
  if (converted?.report?.mixedEol || converted?.doc?.attrs?.readOnly) return 'mixed';
  return null;
}

/**
 * One scene as the nodes it adds to the chapter: its sceneBreak and its blocks (an empty paragraph when it has none, so a scene always exists and can be typed into).
 * @param {{ id: string, title?: string, body?: string, problem?: any, raw?: boolean, failed?: boolean }} scene
 * @returns {any[]}
 */
export function sceneNodes(scene) {
  const converted = typeof scene.body === 'string' && !scene.failed ? markdownToDoc(scene.body) : null;
  const reason = readOnlyReason(scene, converted);
  const title = scene.title ?? '';
  if (reason === 'problem' || reason === 'raw' || reason === 'failed') {
    // shown exactly as it is on disk, never edited, never saved
    const text = typeof scene.body === 'string' ? scene.body : '';
    return [
      { type: 'sceneBreak', attrs: { sceneId: scene.id, title, lead: '', trail: '', eol: 'lf', readOnly: true, reason } },
      { type: 'rawBlock', attrs: { text } },
    ];
  }
  const attrs = converted.doc.attrs;
  const blocks = converted.doc.content.length > 0 ? converted.doc.content : [{ ...EMPTY_PARAGRAPH }];
  return [
    { type: 'sceneBreak', attrs: { sceneId: scene.id, title, lead: attrs.lead, trail: attrs.trail, eol: attrs.eol, readOnly: reason === 'mixed', reason } },
    ...blocks,
  ];
}

/**
 * The chapter document (ProseMirror JSON): a sceneBreak before each scene's blocks.
 * @param {{ id: string, title?: string, body?: string, problem?: any, raw?: boolean, failed?: boolean }[]} scenes in chapter order
 */
export function buildChapterDoc(scenes) {
  return { type: 'doc', content: scenes.flatMap(sceneNodes) };
}

/** A node as plain JSON that docToMarkdown accepts: only top-level blocks keep their `gap`, and unset attrs are dropped. */
function clean(node, top) {
  const out = { type: node.type };
  if (node.attrs) {
    const attrs = { ...node.attrs };
    if (!top || typeof attrs.gap !== 'string') delete attrs.gap;
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  if (node.content) out.content = node.content.map((c) => clean(c, false));
  if (node.text !== undefined) out.text = node.text;
  if (node.marks) out.marks = node.marks;
  return out;
}

/**
 * The chapter document cut at its scene breaks: one document per scene, each in the shape docToMarkdown takes.
 * @param {any} doc the chapter document, as JSON or as a ProseMirror node
 * @param {{ only?: Set<string> | string[] | null }} [options] `only`: just these scenes
 * @returns {{ sceneId: string, doc: any }[]}
 */
export function splitChapterDoc(doc, { only = null } = {}) {
  const json = typeof doc?.toJSON === 'function' ? doc.toJSON() : doc;
  const want = only ? new Set(only) : null;
  /** @type {{ sceneId: string, doc: any }[]} */
  const out = [];
  let current = null;
  for (const node of json.content ?? []) {
    if (node.type === 'sceneBreak') {
      const a = node.attrs ?? {};
      const attrs = { lead: a.lead ?? '', trail: a.trail ?? '', eol: a.eol === 'crlf' ? 'crlf' : 'lf' };
      if (a.readOnly) attrs.readOnly = true;
      current = { sceneId: a.sceneId, doc: { type: 'doc', attrs, content: [] } };
      out.push(current);
    } else if (current) current.doc.content.push(clean(node, true));
    else throw new Error('a chapter document starts with a scene break');
  }
  return want ? out.filter((s) => want.has(s.sceneId)) : out;
}

/**
 * The scenes whose Markdown differs from the text already held for them. A read-only scene is never reported. A scene that cannot be written (RichSerializeError)
 * is listed in `failed` and is never reported as changed: the caller keeps its draft and saves nothing.
 * @param {Map<string, string> | Record<string, string>} known sceneId -> the text last saved or held for the scene
 * @param {{ sceneId: string, doc: any }[]} current from splitChapterDoc
 * @returns {{ changed: { sceneId: string, markdown: string }[], failed: { sceneId: string, error: string }[] }}
 */
export function changedScenes(known, current) {
  const changed = [];
  const failed = [];
  for (const { sceneId, doc } of current) {
    if (doc.attrs?.readOnly) continue;
    const base = known instanceof Map ? known.get(sceneId) : known[sceneId];
    if (typeof base !== 'string') continue;
    try {
      const markdown = docToMarkdown(doc);
      if (markdown !== base) changed.push({ sceneId, markdown });
    } catch (e) {
      if (!(e instanceof RichSerializeError)) throw e;
      failed.push({ sceneId, error: e.message });
    }
  }
  return { changed, failed };
}

// ---------------------------------------------------------------------------------------------------------------- positions (ProseMirror nodes)

/**
 * The scenes of a chapter node: [{ sceneId, node (its sceneBreak), breakPos, from, to, blocks }]. `from`..`to` covers the scene's blocks. Blocks before the first
 * break (a broken document) belong to a scene with `sceneId: null`.
 * @param {import('@tiptap/pm/model').Node} doc
 */
export function sceneSlices(doc) {
  /** @type {{ sceneId: string | null, node: any, breakPos: number, from: number, to: number, blocks: any[] }[]} */
  const out = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'sceneBreak') {
      out.push({ sceneId: node.attrs.sceneId, node, breakPos: offset, from: offset + node.nodeSize, to: offset + node.nodeSize, blocks: [] });
      return;
    }
    if (out.length === 0) out.push({ sceneId: null, node: null, breakPos: 0, from: 0, to: 0, blocks: [] });
    const s = out[out.length - 1];
    s.blocks.push(node);
    s.to = offset + node.nodeSize;
  });
  return out;
}

/** The scene a document position is in (the last break at or before it), or null. @param {import('@tiptap/pm/model').Node} doc @param {number} pos */
export function sceneAt(doc, pos) {
  let found = null;
  for (const s of sceneSlices(doc)) {
    if (s.breakPos <= pos) found = s.sceneId;
    else break;
  }
  return found;
}

/** Did this scene's break or blocks change between two chapter documents? ProseMirror shares unchanged nodes, so identity is enough. */
export function sliceChanged(a, b) {
  if (!a || !b) return true;
  if (a.node !== b.node || a.blocks.length !== b.blocks.length) return true;
  return a.blocks.some((n, i) => n !== b.blocks[i]);
}

/**
 * The ids of the scenes whose content differs between the previous slices and this document (what has to be serialised again).
 * @param {ReturnType<typeof sceneSlices>} previous @param {ReturnType<typeof sceneSlices>} next @returns {string[]}
 */
export function editedSceneIds(previous, next) {
  const before = new Map(previous.map((s) => [s.sceneId, s]));
  return next.filter((s) => s.sceneId !== null && sliceChanged(before.get(s.sceneId), s)).map((s) => s.sceneId);
}

/**
 * A transaction that replaces one scene's blocks with those of `markdown` (a restored draft, the file's version after a conflict), and sets the break's document attrs.
 * Null when the scene is not in the document. It is not added to the undo history.
 * @param {import('@tiptap/pm/state').EditorState} state @param {string} sceneId @param {string} markdown
 */
export function replaceSceneTransaction(state, sceneId, markdown) {
  const slice = sceneSlices(state.doc).find((s) => s.sceneId === sceneId);
  if (!slice || !slice.node) return null;
  const { doc } = markdownToDoc(markdown);
  const blocks = (doc.content.length > 0 ? doc.content : [{ ...EMPTY_PARAGRAPH }]).map((b) => state.schema.nodeFromJSON(b));
  const tr = state.tr.replaceWith(slice.from, slice.to, blocks);
  tr.setNodeMarkup(slice.breakPos, undefined, {
    ...slice.node.attrs,
    lead: doc.attrs.lead,
    trail: doc.attrs.trail,
    eol: doc.attrs.eol,
    readOnly: Boolean(doc.attrs.readOnly),
    reason: doc.attrs.readOnly ? 'mixed' : null,
  });
  return tr.setMeta('addToHistory', false);
}

/** The author notes of a scene, in order: [{ text, pos }] (`pos`: where the note sits in the chapter document). @param {import('@tiptap/pm/model').Node} doc */
export function authorNotesByScene(doc) {
  /** @type {Map<string, { text: string, pos: number }[]>} */
  const out = new Map();
  for (const s of sceneSlices(doc)) {
    if (s.sceneId === null) continue;
    const notes = [];
    doc.nodesBetween(s.from, s.to, (node, pos) => {
      if (node.type.name === 'authorNote') notes.push({ text: node.attrs.text, pos });
      return node.isBlock || node.childCount > 0;
    });
    out.set(s.sceneId, notes);
  }
  return out;
}
