// The Plan tab's Clues view (Story Planner M8), pure part: kinds, the words for a clue, knower rows and their checks, the clue-by-scene grid, and the request builders. No React, no fetch.
import { bookUrl } from '../structure/helpers.js';
import { sceneName } from './model.js';

/** The three kinds of clue record, with the plain words the form shows next to each. */
export const CLUE_KINDS = [
  { value: 'clue', label: 'Clue', words: 'a hint the reader can notice' },
  { value: 'reveal', label: 'Reveal', words: 'the truth coming out' },
  { value: 'secret', label: 'Secret', words: 'something held back' },
];

/** The words for a kind; an unknown kind is shown as it is. @param {string} kind */
export const kindLabel = (kind) => CLUE_KINDS.find((k) => k.value === kind)?.label ?? String(kind ?? '');

/** The entry the reader is in a knower row's `who` select. */
export const READER = 'reader';

// ---------------------------------------------------------------- URLs and requests

/** GET and POST /api/books/:b/clues */
export const cluesUrl = (bookId) => bookUrl(bookId, '/clues');
/** GET and POST /api/books/:b/clues/:slug, and with the tails /knowers, /archive and /restore. */
export const clueUrl = (bookId, slug, tail = '') => bookUrl(bookId, `/clues/${encodeURIComponent(slug)}${tail}`);

/**
 * The request that starts a clue. The fact is trimmed; `kind` is sent when given; `fields` keeps only what is set (`planted` as a list of scene ids, `revealed` as a scene id, `red_herring` as true).
 * @param {string} bookId @param {{ fact: string, kind?: string, fields?: { planted?: string[], revealed?: string | null, red_herring?: boolean }, dryRun?: boolean }} v
 */
export function createClueRequest(bookId, { fact, kind, fields, dryRun }) {
  const kept = {};
  if (Array.isArray(fields?.planted) && fields.planted.length > 0) kept.planted = fields.planted.map(String);
  if (typeof fields?.revealed === 'string' && fields.revealed !== '') kept.revealed = fields.revealed;
  if (fields?.red_herring === true) kept.red_herring = true;
  return {
    url: cluesUrl(bookId),
    body: { fact: String(fact ?? '').trim(), ...(typeof kind === 'string' && kind !== '' ? { kind } : {}), ...(Object.keys(kept).length > 0 ? { fields: kept } : {}), ...(dryRun ? { dryRun: true } : {}) },
  };
}

/**
 * The body that changes a clue: the given parts plus the sha256 last read. `fact`, `kind`, `planted`, `revealed` (null clears it) and `red_herring` go in `fields`; `body` is the notes text.
 * @param {{ sha256: string }} item @param {{ fact?: string, kind?: string, planted?: string[], revealed?: string | null, red_herring?: boolean, body?: string, dryRun?: boolean }} patch
 */
export function updateClueBody(item, { fact, kind, planted, revealed, red_herring, body, dryRun } = {}) {
  const fields = {
    ...(fact !== undefined ? { fact: String(fact).trim() } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(planted !== undefined ? { planted: planted.map(String) } : {}),
    ...(revealed !== undefined ? { revealed: revealed === null || revealed === '' ? null : revealed } : {}),
    ...(red_herring !== undefined ? { red_herring: Boolean(red_herring) } : {}),
  };
  return {
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(body !== undefined ? { body } : {}),
    base_sha256: item.sha256,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/**
 * The body that writes the whole knower list: `who` ("reader" or an entry id) and `scene` always, `how` trimmed and left out when empty, `reliable: false` only for a knower who believes something false.
 * @param {{ sha256: string }} item @param {{ who: string, scene: string, how?: string, reliable?: boolean }[]} rows @param {{ dryRun?: boolean }} [opts]
 */
export function knowersBody(item, rows, { dryRun } = {}) {
  const knowers = rows.map((r) => {
    const out = { who: String(r.who), scene: String(r.scene) };
    const how = String(r.how ?? '').trim();
    if (how !== '') out.how = how;
    if (r.reliable === false) out.reliable = false;
    return out;
  });
  return { knowers, base_sha256: item.sha256, ...(dryRun ? { dryRun: true } : {}) };
}

/** The request that archives a clue. @param {string} bookId @param {string} slug @param {{ sha256?: string }} [item] */
export const archiveClueRequest = (bookId, slug, item) => ({ url: clueUrl(bookId, slug, '/archive'), body: typeof item?.sha256 === 'string' ? { base_sha256: item.sha256 } : {} });
/** The request that restores an archived clue. @param {string} bookId @param {string} slug */
export const restoreClueRequest = (bookId, slug) => ({ url: clueUrl(bookId, slug, '/restore'), body: {} });

/** True when a refused write means the file changed since it was read (409 `conflict`). */
export const isClueConflict = (status, json) => status === 409 && (json?.error === 'conflict' || json?.code === 'CONFLICT');

/** A sentence for a refused clue write; null for the ones explainFailure words already. */
export const explainClueFailure = (status, json) => (isClueConflict(status, json) ? 'This clue changed elsewhere. Reload to see the latest; your edits here are kept until you do.' : null);

// ---------------------------------------------------------------- words for a clue

/** "Planted in 3 scenes" / "Planted in 1 scene" / "Planted in 0 scenes". @param {{ planted?: any[] }} clue */
export function plantedText(clue) {
  const n = (clue.planted ?? []).length;
  return `Planted in ${n} ${n === 1 ? 'scene' : 'scenes'}`;
}

/** "Revealed in The Ferry" or "Not revealed yet". @param {{ revealed?: { title?: string } | null }} clue */
export const revealedText = (clue) => (clue.revealed ? `Revealed in ${sceneName(clue.revealed.title)}` : 'Not revealed yet');

/** The name of a knower: "The reader" or the character's name. @param {{ who?: { name?: string, reader?: boolean } }} k */
export const knowerName = (k) => (k.who?.reader ? 'The reader' : (k.who?.name ?? 'Someone'));

// ---------------------------------------------------------------- knower rows

let rowUid = 0;
/** A blank knower row for the editor. @param {Partial<{ who: string, scene: string, how: string, reliable: boolean }>} [v] */
export const blankKnower = (v = {}) => ({ uid: `k${(rowUid += 1)}`, who: '', scene: '', how: '', reliable: true, ...v });

/** The editor's rows from a clue's `knowers` (GET /clues): `who` is "reader" or the entry id. @param {{ knowers?: any[] }} clue */
export const knowerRows = (clue) =>
  (clue.knowers ?? []).map((k) => blankKnower({ who: k.who?.reader ? READER : (k.who?.id ?? ''), scene: k.scene?.id ?? '', how: k.how ?? '', reliable: k.reliable !== false }));

/** The rows as plain data, to tell whether anything changed. @param {{ who: string, scene: string, how?: string, reliable?: boolean }[]} rows */
export const plainKnowers = (rows) => JSON.stringify(rows.map((r) => [r.who, r.scene, String(r.how ?? '').trim(), r.reliable !== false]));

/**
 * What is wrong with the knower rows, in words: a row needs someone and a scene, and the same person can learn it in the same scene only once.
 * @param {{ who: string, scene: string }[]} rows @returns {{ ok: boolean, errors: { index: number, message: string }[] }}
 */
export function validateKnowers(rows) {
  const errors = [];
  const seen = new Set();
  rows.forEach((r, index) => {
    if (r.who === '') errors.push({ index, message: `Row ${index + 1}: choose who learns it.` });
    else if (r.scene === '') errors.push({ index, message: `Row ${index + 1}: choose the scene.` });
    else {
      const key = `${r.who}|${r.scene}`;
      if (seen.has(key)) errors.push({ index, message: `Row ${index + 1}: the same person is already listed for that scene.` });
      seen.add(key);
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- the clue-by-scene grid

/** A scene title cut for a column head. @param {string | undefined} title @param {number} [max] */
export function shortTitle(title, max = 14) {
  const t = sceneName(title);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The grid of clues (rows) against scenes (columns, in reading order). A cell has `planted` (P), `revealed` (R) and `knowers` (K: the names of those who learn it there); `marks` is the letters in that order,
 * `tip` the tooltip ("Planted. Revealed. Learned by: The reader, Maren.") and `label` the cell's accessible name. With `onlyMarked`, scenes where no clue has a mark are left out.
 * @param {{ clues: any[], scenes: { id: string, title?: string }[], onlyMarked?: boolean }} p
 * @returns {{ columns: { id: string, title: string, short: string }[], rows: { slug: string, fact: string, cells: { scene: string, planted: boolean, revealed: boolean, knowers: string[], marks: string, tip: string, label: string }[] }[], hidden: number }}
 */
export function clueGrid({ clues, scenes, onlyMarked = false }) {
  const rows = clues.map((clue) => {
    const planted = new Set((clue.planted ?? []).map((p) => p.id));
    const cells = scenes.map((s) => {
      const isPlanted = planted.has(s.id);
      const isRevealed = clue.revealed?.id === s.id;
      const knowers = (clue.knowers ?? []).filter((k) => k.scene?.id === s.id).map(knowerName);
      const marks = `${isPlanted ? 'P' : ''}${isRevealed ? 'R' : ''}${knowers.length > 0 ? 'K' : ''}`;
      const parts = [];
      if (isPlanted) parts.push('Planted.');
      if (isRevealed) parts.push('Revealed.');
      if (knowers.length > 0) parts.push(`Learned by: ${knowers.join(', ')}.`);
      const tip = parts.join(' ');
      return { scene: s.id, planted: isPlanted, revealed: isRevealed, knowers, marks, tip, label: `${clue.fact}, ${sceneName(s.title)}: ${tip === '' ? 'no marks' : tip}` };
    });
    return { slug: clue.slug, fact: clue.fact, cells };
  });
  const keep = scenes.map((_, i) => !onlyMarked || rows.some((r) => r.cells[i].marks !== ''));
  const columns = scenes.filter((_, i) => keep[i]).map((s) => ({ id: s.id, title: sceneName(s.title), short: shortTitle(s.title) }));
  return { columns, rows: rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => keep[i]) })), hidden: keep.filter((k) => !k).length };
}
