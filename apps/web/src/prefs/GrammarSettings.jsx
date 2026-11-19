// Settings -> Grammar checks (M13-J02 section 5). Per book: the on/off switch, the dialect, the book dictionary and the rules turned off. Saved as the book's
// `checks.grammar` preference (book.md) through POST /api/books/:b/checks/grammar. Checks run on this computer; nothing is sent anywhere.
import { useId, useState } from 'react';
import { postJson, useApi } from '../api.js';

/** The dialects Harper offers, with the words the author reads (the ids are @storyforge/format's GRAMMAR_DIALECTS). */
export const DIALECT_CHOICES = Object.freeze([
  { id: 'american', label: 'American English' },
  { id: 'british', label: 'British English' },
  { id: 'australian', label: 'Australian English' },
  { id: 'canadian', label: 'Canadian English' },
  { id: 'indian', label: 'Indian English' },
]);

/** What a book has when nothing sets it (BUILTIN.checks.grammar). */
export const DEFAULT_GRAMMAR = Object.freeze({ enabled: false, language: 'en', dialect: 'american', words: [], rules: {} });

/** The names of the rules turned off. @param {Record<string, unknown> | undefined} rules */
export const disabledRules = (rules) => Object.keys(rules ?? {}).filter((name) => rules?.[name] === false);

/** @param {string} bookId @param {Record<string, unknown>} patch @returns {Promise<{ ok: boolean, message?: string }>} */
export async function saveGrammar(bookId, patch) {
  try {
    const r = await postJson(`/api/books/${encodeURIComponent(bookId)}/checks/grammar`, patch);
    return r.status === 200 ? { ok: true } : { ok: false, message: r.json?.message ?? `Not saved (${r.status}).` };
  } catch {
    return { ok: false, message: 'The server could not be reached.' };
  }
}

/**
 * One book's controls. Presentational.
 * @param {{ book: { id: string, title: string }, grammar: { enabled: boolean, dialect: string, words: string[], rules: Record<string, unknown> }, busy?: boolean,
 *   onChange: (patch: Record<string, unknown>, done: string) => void }} props
 */
export function GrammarBookControls({ book, grammar, busy = false, onChange }) {
  const id = useId();
  const rules = disabledRules(grammar.rules);
  return (
    <div className="gr-settings-book" role="group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{book.title}</h3>
      <div className="field">
        <label className="gr-switch">
          <input type="checkbox" checked={grammar.enabled === true} disabled={busy} onChange={(e) => onChange({ enabled: e.target.checked }, `${book.title}: grammar checks ${e.target.checked ? 'on' : 'off'}.`)} /> Check grammar and spelling (English)
        </label>
      </div>
      <div className="field">
        <label htmlFor={`${id}-dialect`}>Dialect</label>
        <select id={`${id}-dialect`} value={grammar.dialect} disabled={busy} onChange={(e) => onChange({ dialect: e.target.value }, `${book.title}: dialect set.`)}>
          {DIALECT_CHOICES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <h4 id={`${id}-words`}>Dictionary</h4>
      {grammar.words.length === 0 ? (
        <p className="muted">No words yet. Use Add to dictionary on a spelling suggestion in the Grammar panel.</p>
      ) : (
        <ul className="gr-word-list" aria-labelledby={`${id}-words`}>
          {grammar.words.map((w) => (
            <li key={w}>
              <span>{w}</span>{' '}
              <button type="button" className="btn btn-small" disabled={busy} aria-label={`Remove ${w} from the dictionary`} onClick={() => onChange({ removeWords: [w] }, `Removed ${w} from the dictionary.`)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4 id={`${id}-rules`}>Rules turned off</h4>
      {rules.length === 0 ? (
        <p className="muted">No rules are turned off.</p>
      ) : (
        <ul className="gr-rule-list" aria-labelledby={`${id}-rules`}>
          {rules.map((name) => (
            <li key={name}>
              <span>{name}</span>{' '}
              <button type="button" className="btn btn-small" disabled={busy} aria-label={`Turn back on the rule ${name}`} onClick={() => onChange({ enableRules: [name] }, `Turned the rule ${name} back on.`)}>
                Turn back on
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A book's row: reads the effective settings (GET /api/preferences?book=) and saves a change. @param {{ book: { id: string, title: string }, rev: number, onSave: (r: { ok: boolean, message?: string }, what: string) => void }} props */
function BookGrammar({ book, rev, onSave }) {
  const { data } = useApi(`/api/preferences?book=${encodeURIComponent(book.id)}`, String(rev));
  const [busy, setBusy] = useState(false);
  const found = data?.effective?.checks?.grammar ?? {};
  const grammar = { ...DEFAULT_GRAMMAR, ...found, words: Array.isArray(found.words) ? found.words : [], rules: found.rules ?? {} };
  return (
    <GrammarBookControls
      book={book}
      grammar={grammar}
      busy={busy || data === null}
      onChange={async (patch, done) => {
        setBusy(true);
        onSave(await saveGrammar(book.id, patch), done);
        setBusy(false);
      }}
    />
  );
}

/**
 * The section from what the server answered (also used by tests).
 * @param {{ books: { id: string, title: string }[], status?: string | null, rev?: number, onSave?: (r: { ok: boolean, message?: string }, what: string) => void }} props
 */
export function GrammarSettingsView({ books, status = null, rev = 0, onSave = () => {} }) {
  return (
    <section aria-labelledby="grammar-checks-heading" className="pref-section">
      <h2 id="grammar-checks-heading">Grammar checks</h2>
      <p className="muted">
        Checks run on this computer and nothing is sent anywhere. The checker is a part of StoryForge (there is nothing to download) of about 20 MB, and it is loaded only when checks are on. Suggestions never change your text until you
        choose one. They are saved per book, in the book (book.md).
      </p>
      {books.length === 0 ? <p className="muted">No books yet.</p> : books.map((b) => <BookGrammar key={b.id} book={b} rev={rev} onSave={onSave} />)}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

/** Settings -> Grammar checks. */
export function GrammarSettings() {
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const { data: books } = useApi('/api/books');
  const list = (Array.isArray(books) ? books : []).map((/** @type {any} */ b) => ({ id: b.id, title: b.title ?? b.slug ?? b.id }));
  return (
    <GrammarSettingsView
      books={list}
      status={status}
      rev={rev}
      onSave={(r, done) => {
        setStatus(r.ok ? done : (r.message ?? 'Not saved.'));
        setRev((n) => n + 1);
      }}
    />
  );
}
