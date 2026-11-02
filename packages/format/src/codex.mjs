// Codex checks (spec 5, 5.1): E209 (two type files for one type), W304 (alias or name shared by two entries).

/** Lower-case, no diacritics, single spaces: the same folding mention matching uses. @param {string} s */
const fold = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** @param {import('./load.mjs').Doc} d @returns {{key:string, text:string, location:string}[]} */
function labelsOf(d) {
  const out = [];
  if (typeof d.fm.name === 'string' && fold(d.fm.name) !== '') out.push({ key: fold(d.fm.name), text: d.fm.name, location: 'name' });
  if (Array.isArray(d.fm.aliases)) {
    d.fm.aliases.forEach((a, i) => {
      if (typeof a === 'string' && fold(a) !== '') out.push({ key: fold(a), text: a, location: `aliases[${i}]` });
    });
  }
  return out;
}

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkCodex(docs, add) {
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const typeFiles = new Map();
  /** @type {Map<string, Set<import('./load.mjs').Doc>>} folded name or alias -> entries using it */
  const users = new Map();
  for (const d of docs) {
    if (d.archived) continue;
    if (d.kind === 'codex-type' && typeof d.fm.type === 'string' && /^[a-z]+$/.test(d.fm.type)) {
      if (!typeFiles.has(d.fm.type)) typeFiles.set(d.fm.type, []);
      typeFiles.get(d.fm.type).push(d);
    } else if (d.kind === 'entry') {
      for (const s of labelsOf(d)) {
        if (!users.has(s.key)) users.set(s.key, new Set());
        users.get(s.key).add(d);
      }
    }
  }
  for (const [type, list] of typeFiles) {
    if (list.length < 2) continue;
    for (const d of list) add('E209', d.file, 'type', `type ${type} is defined by more than one file in codex/_types`);
  }
  for (const d of docs) {
    if (d.archived || d.kind !== 'entry') continue;
    for (const s of labelsOf(d)) {
      if ((users.get(s.key)?.size ?? 0) > 1) add('W304', d.file, s.location, `${s.text} is also a name or alias of another entry; mentions are ambiguous`);
    }
  }
}
