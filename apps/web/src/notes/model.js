// The Notes page's projections (M04-J04). Pure: the page fetches GET /api/books/:b/notes (and /scene-notes) and these functions turn them into what is drawn.
// Research notes are non-canon unless `canon: true`; planning docs and sources are listed next to them.

const enc = encodeURIComponent;
const MARKS = /[̀-ͯ]/g;
const fold = (s) => String(s ?? '').normalize('NFD').replace(MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The sidebar rows, in order. `kind` is the note kind a row shows ('' = every kind). */
export const NOTE_SECTIONS = [
  { key: 'all', label: 'All', kind: '' },
  { key: 'research', label: 'Research', kind: 'research' },
  { key: 'docs', label: 'Planning docs', kind: 'doc' },
  { key: 'sources', label: 'Sources', kind: 'source' },
  { key: 'scene-notes', label: 'Scene notes', kind: null },
];
export const KIND_LABEL = { research: 'Research', doc: 'Planning doc', source: 'Source' };

/** /books/:id/notes with the optional ?section=, ?tag= and ?note= of the page. @param {string} bookId @param {{ section?: string | null, tag?: string | null, note?: string | null }} [q] */
export function notesHref(bookId, { section = null, tag = null, note = null } = {}) {
  const p = new URLSearchParams();
  if (section && section !== 'all') p.set('section', section);
  if (tag) p.set('tag', tag);
  if (note) p.set('note', note);
  const qs = p.toString();
  return `/books/${enc(bookId)}/notes${qs ? `?${qs}` : ''}`;
}

/** @param {string} search the query string of the URL @returns {{ section: string, tag: string | null, note: string | null }} */
export function parseNotesSearch(search = '') {
  const p = new URLSearchParams(search);
  const section = p.get('section');
  return { section: NOTE_SECTIONS.some((s) => s.key === section) || section === 'archived' ? /** @type {string} */ (section) : 'all', tag: p.get('tag') || null, note: p.get('note') || null };
}

/**
 * Counts for the sidebar: every live note, per section, the archived ones, the scene notes, and the tag list.
 * @param {any[]} notes GET /notes `notes` @param {number} [sceneNoteCount]
 */
export function sidebarCounts(notes, sceneNoteCount = 0) {
  const live = notes.filter((n) => !n.archived);
  const of = (kind) => live.filter((n) => n.kind === kind).length;
  return { all: live.length, research: of('research'), docs: of('doc'), sources: of('source'), 'scene-notes': sceneNoteCount, archived: notes.length - live.length };
}

/**
 * The list of a section: `section` a key of NOTE_SECTIONS or 'archived'; `tag` keeps research notes with that tag; `query` matches title, tags, author, cite key and
 * the linked entries' names; `textIds` (a Set of ids the full-text search found in the bodies) adds those notes too.
 * @param {any[]} notes @param {{ section?: string, tag?: string | null, query?: string, textIds?: Set<string> | null }} f
 */
export function filterNotes(notes, { section = 'all', tag = null, query = '', textIds = null } = {}) {
  const row = NOTE_SECTIONS.find((s) => s.key === section);
  const q = fold(query);
  return notes.filter((n) => {
    if (section === 'archived' ? !n.archived : n.archived) return false;
    if (row && row.kind && n.kind !== row.kind) return false;
    if (tag && !n.tags.includes(tag)) return false;
    if (q === '') return true;
    const haystack = fold([n.title, n.tags.join(' '), n.cite_key, n.source?.author, n.links.map((l) => l.name ?? l.ref).join(' ')].join(' '));
    return haystack.includes(q) || Boolean(textIds && textIds.has(n.id));
  });
}

/** The page's title for a section. @param {string} section */
export const sectionTitle = (section) => (section === 'archived' ? 'Archived' : (NOTE_SECTIONS.find((s) => s.key === section)?.label ?? 'Notes'));

/** "Updated Nov 2, 2026" from an ISO time. @param {string | null} iso */
export function updatedLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One source as a citation: "Tide Tables for the North Shore (1998)". @param {{ title: string | null, source?: { author?: string, year?: string } }} s */
export function citationOf(s) {
  const bits = [s.source?.author, s.title, s.source?.year ? `(${s.source.year})` : ''].filter((x) => x && String(x).trim() !== '');
  return bits.join(', ').replace(/, \(/, ' (');
}

/** Research notes whose `links` name the entry (live notes only): the Research section of the Codex inspector. @param {any[] | null | undefined} notes @param {{ id: string, slug?: string | null }} entry */
export function researchForEntry(notes, entry) {
  return (notes ?? []).filter((n) => n.kind === 'research' && !n.archived && n.links.some((l) => l.id === entry.id || (l.id === null && l.ref === entry.slug)));
}

/**
 * Research notes that link any entry or thread of the scene (the front matter's characters, locations, POV and threads, and every [[link]] of the body): the Research
 * section of the editor rail. Each result has `via`: the names that matched.
 * @param {any[] | null | undefined} notes @param {{ id: string | null, name: string }[]} items sceneLinkItems()
 */
export function researchForScene(notes, items) {
  const wanted = new Map(items.filter((i) => i.id).map((i) => [i.id, i.name]));
  const out = [];
  for (const n of notes ?? []) {
    if (n.kind !== 'research' || n.archived) continue;
    const via = n.links.filter((l) => l.id && wanted.has(l.id) && (l.kind === 'entry' || l.kind === 'thread')).map((l) => wanted.get(l.id));
    if (via.length > 0) out.push({ ...n, via: [...new Set(via)] });
  }
  return out;
}

/** Scene notes grouped by chapter, in book order: [{ key, label, scenes: [{ id, title, notes: [{ text, line }] }] }]. @param {{ scenes?: any[] } | null | undefined} data GET /scene-notes */
export function groupSceneNotes(data) {
  const groups = [];
  for (const s of data?.scenes ?? []) {
    const key = `${s.act}/${s.chapter}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: s.chapter_label ?? `Chapter ${s.chapter}`, scenes: [] };
      groups.push(g);
    }
    g.scenes.push({ id: s.id, title: s.title, notes: s.notes });
  }
  return groups;
}

/** The manuscript at a scene and line (the editor jumps there). @param {string} bookId @param {string} sceneId @param {number} line */
export const sceneLineHref = (bookId, sceneId, line) => `/books/${enc(bookId)}?scene=${enc(sceneId)}&line=${line}`;

/** The text of a comma-separated tag box as a clean list. @param {string} text */
export const tagsOf = (text) => [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))];
