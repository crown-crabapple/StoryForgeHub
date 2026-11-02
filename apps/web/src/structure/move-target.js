// Pure target computation for moving scenes (M03-J03): the drop position under the pointer, the Alt+Up/Down
// slot, the Move... dialog options, and the sentences announced for them. No DOM, no network.
//
// `book` is the GET /api/books/:id answer: { acts: [{ act, label, title?, chapters: [{ chapter, label, title?, scenes: [{ id, title }] }] }] }.
// A target is { chapter, act, after } exactly as the move route takes it (after = scene id, or null for first in the chapter).

const sceneTitle = (s) => s?.title || 'Untitled scene';
const chapterTitle = (ch) => (ch.title ? `${ch.label}: ${ch.title}` : ch.label);
const actTitle = (a) => (a.title ? `${a.label}: ${a.title}` : a.label);

/** Chapters in book order, each with its act number: [{ act, chapter, label, title, scenes }]. Empty chapters included. */
export function chaptersInOrder(book) {
  return (book?.acts ?? []).flatMap((a) => a.chapters.map((c) => ({ act: a.act, chapter: c.chapter, label: c.label, title: c.title ?? null, scenes: c.scenes })));
}

/** Every scene in book order: [{ id, title, act, chapter }]. */
export function scenesInOrder(book) {
  return chaptersInOrder(book).flatMap((c) => c.scenes.map((s) => ({ id: s.id, title: s.title ?? '', act: c.act, chapter: c.chapter })));
}

/** Where a scene is now: { act, chapter, index, prevId, chapterNode } or null. */
export function locate(book, sceneId) {
  for (const c of chaptersInOrder(book)) {
    const index = c.scenes.findIndex((s) => s.id === sceneId);
    if (index >= 0) return { act: c.act, chapter: c.chapter, index, prevId: index > 0 ? c.scenes[index - 1].id : null, chapterNode: c };
  }
  return null;
}

/** 'before' for the upper half of a row, 'after' for the lower half (clientY and the row's bounding rect). */
export function halfOf(clientY, rect) {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

/** True when the target is the scene's current slot (same chapter, same predecessor). */
export function isCurrentSlot(book, sceneId, target) {
  const at = locate(book, sceneId);
  return Boolean(at) && at.chapter === target.chapter && at.prevId === target.after;
}

/**
 * The words announced for a target: "Move The Key after Low Tide in Chapter 3" / "to the start of ..." / "to the end of ..." / "into empty ...".
 * `indicator`: { kind: 'before' | 'after' | 'end' | 'start', sceneId?, chapter }.
 */
export function describeTarget(book, sceneId, indicator) {
  const mover = scenesInOrder(book).find((s) => s.id === sceneId);
  const name = sceneTitle(mover);
  const ch = chaptersInOrder(book).find((c) => c.chapter === indicator.chapter);
  const where = ch ? chapterTitle(ch) : `chapter ${indicator.chapter}`;
  const ref = indicator.sceneId ? sceneTitle(ch?.scenes.find((s) => s.id === indicator.sceneId)) : null;
  switch (indicator.kind) {
    case 'before':
      return `Move ${name} before ${ref} in ${where}`;
    case 'after':
      return `Move ${name} after ${ref} in ${where}`;
    case 'start':
      return `Move ${name} to the start of ${where}`;
    default:
      return ch && ch.scenes.filter((s) => s.id !== sceneId).length === 0 ? `Move ${name} into empty ${where}` : `Move ${name} to the end of ${where}`;
  }
}

/**
 * What a drop would do. `over`: { kind: 'scene', sceneId, half: 'before' | 'after' } (the row under the pointer and its half)
 * or { kind: 'chapter', chapter } (a chapter row: the end of that chapter).
 * @returns {{ chapter: number, act: number, after: string | null, noop: boolean,
 *   indicator: { kind: 'before' | 'after' | 'end', sceneId: string | null, chapter: number }, text: string } | null}
 *   null when the dragged scene or the row is unknown. `noop`: dropping on itself or into its current slot.
 */
export function dropTarget(book, draggedId, over) {
  const dragged = locate(book, draggedId);
  if (!dragged || !over) return null;
  const chapters = chaptersInOrder(book);
  let chapterNode;
  let indicator;
  let after;
  if (over.kind === 'chapter') {
    chapterNode = chapters.find((c) => c.chapter === over.chapter);
    if (!chapterNode) return null;
    const others = chapterNode.scenes.filter((s) => s.id !== draggedId);
    after = others.length ? others[others.length - 1].id : null;
    indicator = { kind: 'end', sceneId: null, chapter: chapterNode.chapter };
  } else {
    const row = locate(book, over.sceneId);
    if (!row) return null;
    chapterNode = row.chapterNode;
    const scenes = chapterNode.scenes;
    if (over.sceneId === draggedId) {
      after = dragged.prevId;
      indicator = { kind: over.half === 'before' ? 'before' : 'after', sceneId: over.sceneId, chapter: chapterNode.chapter };
      return finish(book, draggedId, chapterNode, after, indicator, true);
    }
    if (over.half === 'before') {
      const pred = row.index > 0 ? scenes[row.index - 1].id : null;
      after = pred === draggedId ? dragged.prevId : pred;
      indicator = { kind: 'before', sceneId: over.sceneId, chapter: chapterNode.chapter };
    } else {
      after = over.sceneId;
      indicator = { kind: 'after', sceneId: over.sceneId, chapter: chapterNode.chapter };
    }
  }
  return finish(book, draggedId, chapterNode, after, indicator, false);
}

function finish(book, draggedId, chapterNode, after, indicator, forceNoop) {
  const target = { chapter: chapterNode.chapter, act: chapterNode.act, after };
  const noop = forceNoop || isCurrentSlot(book, draggedId, target);
  return { ...target, noop, indicator, text: describeTarget(book, draggedId, indicator) };
}

/**
 * The slot for Alt+Up / Alt+Down: one place up or down in book order. Moving down from the last scene of a chapter puts it
 * first in the next chapter (an empty one too, in the next act too); moving up from the first scene puts it last in the
 * previous chapter.
 * @param {any} book @param {string} sceneId @param {'up' | 'down'} direction
 * @returns {{ chapter: number, act: number, after: string | null, text: string } | null} null at the very start / end of the book or for an unknown scene
 */
export function keyboardTarget(book, sceneId, direction) {
  const at = locate(book, sceneId);
  if (!at || (direction !== 'up' && direction !== 'down')) return null;
  const chapters = chaptersInOrder(book);
  const here = chapters.findIndex((c) => c.chapter === at.chapter);
  const scenes = at.chapterNode.scenes;
  const make = (node, after, indicator) => ({ chapter: node.chapter, act: node.act, after, text: describeTarget(book, sceneId, { ...indicator, chapter: node.chapter }) });
  if (direction === 'down') {
    if (at.index < scenes.length - 1) return make(at.chapterNode, scenes[at.index + 1].id, { kind: 'after', sceneId: scenes[at.index + 1].id });
    const next = chapters[here + 1];
    if (!next) return null;
    return make(next, null, { kind: 'start' });
  }
  if (at.index > 0) {
    const after = at.index > 1 ? scenes[at.index - 2].id : null;
    return after === null ? make(at.chapterNode, null, { kind: 'start' }) : make(at.chapterNode, after, { kind: 'after', sceneId: after });
  }
  const prev = chapters[here - 1];
  if (!prev) return null;
  const last = prev.scenes[prev.scenes.length - 1] ?? null;
  return last ? make(prev, last.id, { kind: 'after', sceneId: last.id }) : make(prev, null, { kind: 'end' });
}

/**
 * Chapter choices of the Move... dialog: every chapter of every act, empty ones too.
 * @returns {{ act: number, label: string, chapters: { value: string, chapter: number, act: number, label: string, empty: boolean }[] }[]}
 */
export function chapterOptions(book) {
  return (book?.acts ?? []).map((a) => ({
    act: a.act,
    label: actTitle(a),
    chapters: a.chapters.map((c) => ({ value: String(c.chapter), chapter: c.chapter, act: a.act, label: chapterTitle(c) + (c.scenes.length === 0 ? ' (empty)' : ''), empty: c.scenes.length === 0 })),
  }));
}

/**
 * Position choices for a chapter in the Move... dialog: "At the start", then "After <scene>" for each scene of the chapter
 * (the moving scene itself is not offered). `value` is '' for the start, else the scene id.
 * @returns {{ value: string, label: string }[]}
 */
export function positionOptions(book, chapter, sceneId) {
  const ch = chaptersInOrder(book).find((c) => c.chapter === chapter);
  if (!ch) return [];
  return [{ value: '', label: 'At the start' }, ...ch.scenes.filter((s) => s.id !== sceneId).map((s) => ({ value: s.id, label: `After ${sceneTitle(s)}` }))];
}

/** The Position select's value that leaves the scene where it is (its current predecessor, or '' for first), for its own chapter. */
export function currentPosition(book, sceneId) {
  const at = locate(book, sceneId);
  return at ? { chapter: at.chapter, value: at.prevId ?? '' } : null;
}

/** Target from the dialog's two selects: chapter value (a number as text) and position value ('' = at the start). */
export function dialogTarget(book, chapterValue, positionValue) {
  const ch = chaptersInOrder(book).find((c) => String(c.chapter) === String(chapterValue));
  if (!ch) return null;
  return { chapter: ch.chapter, act: ch.act, after: positionValue === '' || positionValue == null ? null : positionValue };
}
