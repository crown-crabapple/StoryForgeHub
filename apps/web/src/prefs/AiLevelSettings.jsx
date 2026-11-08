// Settings -> AI level (M12). How much an AI connection (an MCP client or a plugin token) may do in a book, whatever its token was granted: the book's level always
// wins. Saved as the `ai.level` project preference: in the book's book.md, or as the library's default in library.md (a book that sets none follows it). Unlike the
// rest of the appearance settings this writes to the project, so each row says where the effective level comes from.
import { useId, useState } from 'react';
import { postJson, useApi } from '../api.js';

/** The four levels, lowest to highest, with the one plain line the author reads (the same ids as @storyforge/format AI_LEVELS; a test compares them). */
export const AI_LEVEL_CHOICES = Object.freeze([
  { id: 'off', label: 'Off', line: 'AI can only read.' },
  { id: 'advisor', label: 'Advisor', line: 'Suggests edits, adds tasks, runs checks.' },
  { id: 'planner', label: 'Planner', line: 'Also changes the plan, canvas, workspace docs and ledgers.' },
  { id: 'cowriter', label: 'Co-writer', line: 'Also creates new chapters and scenes as drafts.' },
]);
/** What a book has when nothing sets a level (the server's DEFAULT_AI_LEVEL). */
export const DEFAULT_LEVEL = 'planner';

/** Where the effective level comes from, in words. @param {string | undefined} source builtin | profile | library | book */
export const sourceText = (source) => (source === 'book' ? 'set for this book (book.md)' : source === 'library' ? 'the library default (library.md)' : source === 'profile' ? 'your profile' : 'the built-in default');
/** The select's value as a level: '' is "not set here, follow the layer above" (null). @param {string} value @returns {string | null} */
export const levelFromChoice = (value) => (value === '' ? null : value);
const labelOf =(/** @type {string} */ id) => AI_LEVEL_CHOICES.find((c) => c.id === id)?.label ?? id;

/**
 * One level control: a select ("Follow the library default" or one of the four levels), the line for the level in effect, and where it comes from.
 * @param {{ title: string, inherit: string, own: string | null, effective: string, source: string | undefined, busy?: boolean, onChange: (level: string | null) => void }} props
 *   `own`: the level this layer sets itself, or null (it follows the layer above); `inherit`: the label of the "not set" choice.
 */
export function AiLevelControl({ title, inherit, own, effective, source, busy = false, onChange }) {
  const id = useId();
  const choice = AI_LEVEL_CHOICES.find((c) => c.id === effective) ?? AI_LEVEL_CHOICES.find((c) => c.id === DEFAULT_LEVEL);
  return (
    <div className="field ai-level-row">
      <label htmlFor={`${id}-level`}>{title}</label>
      <select id={`${id}-level`} value={own ?? ''} disabled={busy} aria-describedby={`${id}-line`} onChange={(e) => onChange(levelFromChoice(e.target.value))}>
        <option value="">{inherit}</option>
        {AI_LEVEL_CHOICES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <p id={`${id}-line`} className="muted">
        In effect: <strong>{choice?.label}</strong>, from {sourceText(source)}. {choice?.line}
      </p>
    </div>
  );
}

/** A book's row: reads the effective level for that book (GET /api/preferences?book=) and saves a change. @param {{ book: { id: string, title: string }, rev: number, onSave: (r: { ok: boolean, message?: string }, what: string) => void }} props */
function BookLevel({ book, rev, onSave }) {
  const { data } = useApi(`/api/preferences?book=${encodeURIComponent(book.id)}`, String(rev));
  const [busy, setBusy] = useState(false);
  const effective = data?.effective?.ai?.level ?? DEFAULT_LEVEL;
  const source = data?.sources?.['ai.level'];
  const own = data?.layers?.book?.ai?.level ?? null;
  return (
    <AiLevelControl
      title={book.title}
      inherit="Follow the library default"
      own={own}
      effective={effective}
      source={source}
      busy={busy || data === null}
      onChange={async (level) => {
        setBusy(true);
        onSave(await saveLevel(book.id, level, 'book'), `${book.title}: ${level === null ? 'follows the library default' : labelOf(level)}.`);
        setBusy(false);
      }}
    />
  );
}

/** @param {string} bookId @param {string | null} level @param {'book' | 'library'} scope @returns {Promise<{ ok: boolean, message?: string }>} */
export async function saveLevel(bookId, level, scope) {
  try {
    const r = await postJson(`/api/books/${encodeURIComponent(bookId)}/ai-level`, { level, scope });
    return r.status === 200 ? { ok: true } : { ok: false, message: r.json?.message ?? `Not saved (${r.status}).` };
  } catch {
    return { ok: false, message: 'The server could not be reached.' };
  }
}

/**
 * The section from what the server answered (also used by tests): the library default first, then one row per book.
 * @param {{ books: { id: string, title: string }[], library: { own: string | null, effective: string, source: string | undefined } | null, status?: string | null, rev?: number,
 *   onSave?: (r: { ok: boolean, message?: string }, what: string) => void, onSaveLibrary?: (level: string | null) => void, libraryBusy?: boolean }} props
 */
export function AiLevelView({ books, library, status = null, rev = 0, onSave = () => {}, onSaveLibrary = () => {}, libraryBusy = false }) {
  return (
    <section aria-labelledby="ai-level-heading" className="pref-section">
      <h2 id="ai-level-heading">AI level</h2>
      <p className="muted">
        How much an AI connection may do in a book, whatever its key allows: the book&apos;s level always wins. This is saved in the book (book.md) or, for the default, in library.md. Every change an AI makes shows in the book&apos;s AI Activity, with Undo.
      </p>
      <ul className="ai-level-legend">
        {AI_LEVEL_CHOICES.map((c) => (
          <li key={c.id}>
            <strong>{c.label}</strong>: {c.line}
          </li>
        ))}
      </ul>
      {library && (
        <AiLevelControl title="Library default" inherit={`Not set (${labelOf(DEFAULT_LEVEL)})`} own={library.own} effective={library.effective} source={library.source} busy={libraryBusy} onChange={onSaveLibrary} />
      )}
      {books.length === 0 ? <p className="muted">No books yet.</p> : books.map((b) => <BookLevel key={b.id} book={b} rev={rev} onSave={onSave} />)}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

/** Settings -> AI level. */
export function AiLevelSettings() {
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const { data: books } = useApi('/api/books');
  const { data: prefs } = useApi('/api/preferences', String(rev));
  const list = (Array.isArray(books) ? books : []).map((/** @type {any} */ b) => ({ id: b.id, title: b.title ?? b.slug ?? b.id }));
  const library = prefs ? { own: prefs.layers?.library?.ai?.level ?? null, effective: prefs.effective?.ai?.level ?? DEFAULT_LEVEL, source: prefs.sources?.['ai.level'] } : null;
  return (
    <AiLevelView
      books={list}
      library={list.length > 0 ? library : null}
      status={status}
      rev={rev}
      libraryBusy={busy}
      onSave={(r, done) => {
        setStatus(r.ok ? done : (r.message ?? 'Not saved.'));
        setRev((n) => n + 1);
      }}
      onSaveLibrary={async (level) => {
        setBusy(true);
        const r = await saveLevel(list[0].id, level, 'library');
        setStatus(r.ok ? `Library default: ${level === null ? 'not set' : labelOf(level)}.` : (r.message ?? 'Not saved.'));
        setRev((n) => n + 1);
        setBusy(false);
      }}
    />
  );
}
