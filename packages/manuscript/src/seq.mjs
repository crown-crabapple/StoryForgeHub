// Sequence assignment (contract: midpoint / start / end; renumber when no free integer).

/**
 * @param {{id:string, sequence:number}[]} list scenes of the target chapter in order, mover excluded
 * @param {string|null} afterId anchor scene id, or null for first in chapter
 * @param {number|null} currentSeq mover's current sequence if it stays in the same chapter
 * @returns {{error:'BAD_ANCHOR'} | {index:number, sequence:number|null, renumber:boolean}}
 *   sequence is null when the chapter must be renumbered (index is the insertion slot)
 */
export function placeInChapter(list, afterId, currentSeq = null) {
  let index = 0;
  if (afterId !== null) {
    const at = list.findIndex((s) => s.id === afterId);
    if (at < 0) return { error: 'BAD_ANCHOR' };
    index = at + 1;
  }
  const prev = index > 0 ? list[index - 1].sequence : null;
  const next = index < list.length ? list[index].sequence : null;
  if (currentSeq !== null && (prev === null || prev < currentSeq) && (next === null || currentSeq < next)) {
    return { index, sequence: currentSeq, renumber: false };
  }
  let seq;
  if (prev === null && next === null) seq = 10;
  else if (prev === null) seq = Math.max(1, Math.floor(next / 2));
  else if (next === null) seq = prev + 10;
  else seq = Math.floor((prev + next) / 2);
  const free = (prev === null || seq > prev) && (next === null || seq < next) && seq >= 1;
  return free ? { index, sequence: seq, renumber: false } : { index, sequence: null, renumber: true };
}
