// Continuity exceptions (spec 6.4): W307 when two live exceptions (or, M13-J03, two live style dismissals) name the same fingerprint.

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkExceptions(docs, add) {
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const byPrint = new Map();
  for (const d of docs) {
    if (d.archived || (d.kind !== 'continuity-exception' && d.kind !== 'style-dismissal') || typeof d.fm.fingerprint !== 'string') continue;
    // the two kinds have their own fingerprint spaces (cf1-..., sty-...); a style dismissal is only compared with other style dismissals
    const key = `${d.kind}|${d.fm.fingerprint}`;
    if (!byPrint.has(key)) byPrint.set(key, []);
    byPrint.get(key).push(d);
  }
  for (const list of byPrint.values()) {
    if (list.length < 2) continue;
    for (const d of list) add('W307', d.file, 'fingerprint', `another ${d.kind === 'style-dismissal' ? 'style dismissal' : 'continuity exception'} names ${d.fm.fingerprint}`);
  }
}
