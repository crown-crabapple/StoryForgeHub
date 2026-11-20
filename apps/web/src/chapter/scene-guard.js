// Keeps the scene breaks of the chapter document fixed. Pure functions over ProseMirror state (they run headless under `node --test`), plus the plugin that uses them.
//
// A transaction is refused when, afterwards, the scene breaks are not exactly the same ones in the same order, a scene has no block left, or a read-only scene
// changed. Attr-only changes to a break (the title) pass. Backspace at the start of a scene and Delete at its end do nothing (atSceneStart / atSceneEnd).
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { sceneSlices } from './chapter-doc.js';

export const sceneGuardKey = new PluginKey('sceneGuard');

/**
 * Is the document after a change still a valid chapter? @param {import('@tiptap/pm/model').Node} before @param {import('@tiptap/pm/model').Node} after
 */
export function chapterStillValid(before, after) {
  if (before === after) return true;
  const a = sceneSlices(before);
  const b = sceneSlices(after);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].sceneId !== b[i].sceneId) return false; // removed, added or reordered
    if (b[i].sceneId !== null && b[i].blocks.length === 0) return false; // a scene keeps at least one block
    if (a[i].node?.attrs.readOnly) {
      if (a[i].blocks.length !== b[i].blocks.length || a[i].blocks.some((n, k) => !n.eq(b[i].blocks[k]))) return false;
    }
  }
  return true;
}

/** Is this transaction fine to apply to `state`? Programmatic loads set the `sceneGuard: 'allow'` meta. @param {import('@tiptap/pm/state').Transaction} tr @param {import('@tiptap/pm/state').EditorState} state */
export function transactionAllowed(tr, state) {
  if (!tr.docChanged) return true;
  if (tr.getMeta(sceneGuardKey) === 'allow') return true;
  return chapterStillValid(state.doc, tr.doc);
}

export const sceneGuardPlugin = () => new Plugin({ key: sceneGuardKey, filterTransaction: (tr, state) => transactionAllowed(tr, state) });

/** Is the (empty) cursor at the very start of the first block of a scene, so that Backspace would reach the scene break? @param {import('@tiptap/pm/state').EditorState} state */
export function atSceneStart(state) {
  const { $from } = state.selection;
  if ($from.depth < 1 || $from.parentOffset !== 0) return false;
  for (let d = 1; d < $from.depth; d++) if ($from.index(d) !== 0) return false;
  const i = $from.index(0);
  return i > 0 && $from.node(0).child(i - 1).type.name === 'sceneBreak';
}

/** Is the (empty) cursor at the very end of the last block of a scene, so that Delete would reach the next scene break? @param {import('@tiptap/pm/state').EditorState} state */
export function atSceneEnd(state) {
  const { $to } = state.selection;
  if ($to.depth < 1 || $to.parentOffset !== $to.parent.content.size) return false;
  for (let d = 1; d < $to.depth; d++) if ($to.index(d) !== $to.node(d).childCount - 1) return false;
  const doc = $to.node(0);
  const i = $to.index(0);
  return i + 1 < doc.childCount && doc.child(i + 1).type.name === 'sceneBreak';
}
