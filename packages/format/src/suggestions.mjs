// Suggestion documents (M05-J06, FORMAT-v1 9.3): W308 when a suggestion's target does not resolve to a live document of the book.

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkSuggestions(docs, add) {
  const live = new Set(docs.filter((d) => !d.archived && typeof d.fm.id === 'string').map((d) => d.fm.id));
  for (const d of docs) {
    if (d.archived || d.kind !== 'suggestion') continue;
    const target = d.fm.target;
    if (typeof target !== 'string' || target === '') continue; // "" = a new file
    if (!live.has(target)) add('W308', d.file, 'target', `suggestion target ${target} is not a live document of this book`);
  }
}
