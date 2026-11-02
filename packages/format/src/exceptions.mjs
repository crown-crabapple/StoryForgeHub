// Continuity exceptions (spec 6.4): W307 when two live exceptions name the same fingerprint.

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkExceptions(docs, add) {
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const byPrint = new Map();
  for (const d of docs) {
    if (d.archived || d.kind !== 'continuity-exception' || typeof d.fm.fingerprint !== 'string') continue;
    if (!byPrint.has(d.fm.fingerprint)) byPrint.set(d.fm.fingerprint, []);
    byPrint.get(d.fm.fingerprint).push(d);
  }
  for (const [print, list] of byPrint) {
    if (list.length < 2) continue;
    for (const d of list) add('W307', d.file, 'fingerprint', `another continuity exception names ${print}`);
  }
}
