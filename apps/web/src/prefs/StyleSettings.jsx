// Settings -> Style checks (M13-J03 section 9). Per book: the on/off switch and, for each of the six built-in rules, its switch and options (the preferred-terms list, the punctuation
// choices, the thresholds). Saved as the book's `checks.style` preference (book.md) through POST /api/books/:b/checks/style; a rule's options are sent as that rule's whole map.
// Checks run on the server of this computer; nothing is sent anywhere else.
import { useId, useState } from 'react';
import { postJson, useApi } from '../api.js';

/** What a book has when nothing sets it (BUILTIN.checks.style, which is @storyforge/style's STYLE_DEFAULTS). */
export const DEFAULT_STYLE = Object.freeze({
  enabled: false,
  rules: Object.freeze({
    'preferred-terms': Object.freeze({ enabled: true, terms: Object.freeze([]) }),
    'repeated-words': Object.freeze({ enabled: true }),
    punctuation: Object.freeze({ enabled: true, quotes: null, dashes: null, ellipsis: null }),
    'repeated-phrases': Object.freeze({ enabled: false, minWords: 4, window: 300 }),
    'long-paragraphs': Object.freeze({ enabled: false, maxWords: 220 }),
    'isolated-lines': Object.freeze({ enabled: false, minRun: 6 }),
  }),
});

/** The limits of the numbers (the ranges of the contract). */
export const NUMBER_RANGES = Object.freeze({ minWords: [3, 8], window: [50, 2000], maxWords: [50, 2000], minRun: [3, 30] });
export const MAX_TERMS = 500;
const MAX_AVOID = 20;
const MAX_TEXT = 64;

export const PUNCTUATION_CHOICES = Object.freeze({
  quotes: Object.freeze([{ id: 'curly', label: 'Curly (“ ” ‘ ’)' }, { id: 'straight', label: 'Straight (" \')' }]),
  dashes: Object.freeze([{ id: 'em', label: 'Em dash without spaces (word—word)' }, { id: 'em-spaced', label: 'Em dash with spaces (word — word)' }, { id: 'en-spaced', label: 'En dash with spaces (word – word)' }]),
  ellipsis: Object.freeze([{ id: 'character', label: 'One character (…)' }, { id: 'dots', label: 'Three dots (...)' }]),
});

/** The settings of a book over the defaults: every rule has its whole map. @param {any} found the effective `checks.style` */
export function styleOf(found) {
  const rules = {};
  for (const id of Object.keys(DEFAULT_STYLE.rules)) {
    const mine = found?.rules?.[id];
    rules[id] = { ...DEFAULT_STYLE.rules[id], ...(mine && typeof mine === 'object' ? mine : {}) };
  }
  rules['preferred-terms'].terms = Array.isArray(rules['preferred-terms'].terms) ? rules['preferred-terms'].terms : [];
  return { enabled: found?.enabled === true, rules };
}

/**
 * A new preferred-term pair from the form's text: `avoid` is a comma-separated list. A string explains what is wrong; otherwise the pair.
 * @param {string} use @param {string} avoidText @param {boolean} caseSensitive @param {number} count the pairs already there
 * @returns {string | { use: string, avoid: string[], caseSensitive?: true }}
 */
export function newTerm(use, avoidText, caseSensitive, count = 0) {
  const u = use.trim();
  const avoid = [...new Set(avoidText.split(',').map((x) => x.trim()).filter((x) => x !== ''))];
  if (count >= MAX_TERMS) return `A book can have up to ${MAX_TERMS} pairs.`;
  if (u === '' || u.length > MAX_TEXT) return `The spelling to use must be 1 to ${MAX_TEXT} characters.`;
  if (avoid.length === 0 || avoid.length > MAX_AVOID) return `List 1 to ${MAX_AVOID} spellings to avoid, separated by commas.`;
  if (avoid.some((a) => a.length > MAX_TEXT)) return `Each spelling to avoid must be at most ${MAX_TEXT} characters.`;
  if (avoid.includes(u)) return 'A spelling to avoid cannot be the same as the one to use.';
  return caseSensitive ? { use: u, avoid, caseSensitive: true } : { use: u, avoid };
}

/** @param {string} bookId @param {Record<string, unknown>} patch @returns {Promise<{ ok: boolean, message?: string }>} */
export async function saveStyle(bookId, patch) {
  try {
    const r = await postJson(`/api/books/${encodeURIComponent(bookId)}/checks/style`, patch);
    return r.status === 200 ? { ok: true } : { ok: false, message: r.json?.message ?? `Not saved (${r.status}).` };
  } catch {
    return { ok: false, message: 'The server could not be reached.' };
  }
}

/**
 * A whole-number field that is saved when it loses focus, if it is in range.
 * @param {{ id: string, label: string, value: number, min: number, max: number, disabled?: boolean, onCommit: (n: number) => void }} props
 */
function NumberField({ id, label, value, min, max, disabled = false, onCommit }) {
  const [text, setText] = useState(String(value));
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={text}
        disabled={disabled}
        aria-invalid={valid ? undefined : 'true'}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (valid && n !== value) onCommit(n);
        }}
      />
      <p id={`${id}-hint`} className={valid ? 'muted' : 'form-error'}>
        {valid ? `${min} to ${max}.` : `Enter a whole number from ${min} to ${max}.`}
      </p>
    </div>
  );
}

/** @param {{ id: string, label: string, value: string | null, choices: readonly { id: string, label: string }[], disabled?: boolean, onChange: (v: string | null) => void }} props */
function ChoiceSelect({ id, label, value, choices, disabled = false, onChange }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        <option value="">Not checked</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The preferred-terms editor: the pairs with Remove, and a form to add one. @param {{ id: string, terms: any[], busy: boolean, onChange: (terms: any[], done: string) => void }} props */
function TermsEditor({ id, terms, busy, onChange }) {
  const [use, setUse] = useState('');
  const [avoid, setAvoid] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  return (
    <div className="st-terms">
      <h4 id={`${id}-terms`}>Preferred spellings</h4>
      {terms.length === 0 ? (
        <p className="muted">No pairs yet.</p>
      ) : (
        <ul className="gr-word-list" aria-labelledby={`${id}-terms`}>
          {terms.map((t) => (
            <li key={`${t.use}|${t.avoid.join(',')}`}>
              <span>
                {t.avoid.join(', ')} → {t.use}
                {t.caseSensitive === true ? ' (match case)' : ''}
              </span>{' '}
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                aria-label={`Remove the pair ${t.avoid.join(', ')} to ${t.use}`}
                onClick={() => onChange(terms.filter((x) => x !== t), `Removed the pair ${t.avoid.join(', ')} → ${t.use}.`)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field">
        <label htmlFor={`${id}-use`}>Spelling to use</label>
        <input id={`${id}-use`} type="text" value={use} maxLength={MAX_TEXT} disabled={busy} onChange={(e) => setUse(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-avoid`}>Spellings to avoid (separated by commas)</label>
        <input id={`${id}-avoid`} type="text" value={avoid} disabled={busy} onChange={(e) => setAvoid(e.target.value)} />
      </div>
      <div className="field">
        <label className="gr-switch">
          <input type="checkbox" checked={caseSensitive} disabled={busy} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match capital letters exactly
        </label>
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <p>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => {
            const made = newTerm(use, avoid, caseSensitive, terms.length);
            if (typeof made === 'string') {
              setProblem(made);
              return;
            }
            setProblem(null);
            setUse('');
            setAvoid('');
            setCaseSensitive(false);
            onChange([...terms, made], `Added the pair ${made.avoid.join(', ')} → ${made.use}.`);
          }}
        >
          Add pair
        </button>
      </p>
    </div>
  );
}

/**
 * One book's controls. Presentational. `onChange(patch, done)` receives a body for POST /checks/style: `{ enabled }` or `{ rules: { <id>: <that rule's whole map> } }`.
 * @param {{ book: { id: string, title: string }, style: ReturnType<typeof styleOf>, busy?: boolean, onChange: (patch: Record<string, unknown>, done: string) => void }} props
 */
export function StyleBookControls({ book, style, busy = false, onChange }) {
  const id = useId();
  const r = style.rules;
  const setRule = (rule, map, done) => onChange({ rules: { [rule]: map } }, `${book.title}: ${done}`);
  const ruleSwitch = (rule, label) => (
    <label className="gr-switch">
      <input type="checkbox" checked={r[rule].enabled === true} disabled={busy} onChange={(e) => setRule(rule, { ...r[rule], enabled: e.target.checked }, `${label} ${e.target.checked ? 'on' : 'off'}.`)} /> {label}
    </label>
  );
  const number = (rule, key, label) => (
    <NumberField key={`${rule}.${key}.${r[rule][key]}`} id={`${id}-${rule}-${key}`} label={label} value={r[rule][key]} min={NUMBER_RANGES[key][0]} max={NUMBER_RANGES[key][1]} disabled={busy} onCommit={(n) => setRule(rule, { ...r[rule], [key]: n }, `${label} set to ${n}.`)} />
  );
  const choice = (key, label) => (
    <ChoiceSelect id={`${id}-punctuation-${key}`} label={label} value={r.punctuation[key] ?? null} choices={PUNCTUATION_CHOICES[key]} disabled={busy} onChange={(v) => setRule('punctuation', { ...r.punctuation, [key]: v }, `${label} updated.`)} />
  );
  return (
    <div className="gr-settings-book" role="group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{book.title}</h3>
      <div className="field">
        <label className="gr-switch">
          <input type="checkbox" checked={style.enabled === true} disabled={busy} onChange={(e) => onChange({ enabled: e.target.checked }, `${book.title}: style checks ${e.target.checked ? 'on' : 'off'}.`)} /> Check style
        </label>
      </div>

      <div className="st-rule" role="group" aria-labelledby={`${id}-preferred-terms`}>
        <h4 id={`${id}-preferred-terms`}>Preferred terms</h4>
        <div className="field">{ruleSwitch('preferred-terms', 'Flag spellings I want to avoid')}</div>
        <TermsEditor id={`${id}-pt`} terms={r['preferred-terms'].terms} busy={busy} onChange={(terms, done) => setRule('preferred-terms', { ...r['preferred-terms'], terms }, done)} />
      </div>

      <div className="st-rule" role="group" aria-labelledby={`${id}-repeated-words`}>
        <h4 id={`${id}-repeated-words`}>Repeated words</h4>
        <div className="field">{ruleSwitch('repeated-words', 'Flag the same word twice in a row')}</div>
      </div>

      <div className="st-rule" role="group" aria-labelledby={`${id}-punctuation`}>
        <h4 id={`${id}-punctuation`}>Punctuation style</h4>
        <div className="field">{ruleSwitch('punctuation', 'Flag punctuation that differs from my choice')}</div>
        {choice('quotes', 'Quotation marks')}
        {choice('dashes', 'Dashes')}
        {choice('ellipsis', 'Ellipsis')}
      </div>

      <div className="st-rule" role="group" aria-labelledby={`${id}-repeated-phrases`}>
        <h4 id={`${id}-repeated-phrases`}>Repeated phrases (advice)</h4>
        <div className="field">{ruleSwitch('repeated-phrases', 'Point out phrases that come back soon')}</div>
        {number('repeated-phrases', 'minWords', 'Shortest phrase (words)')}
        {number('repeated-phrases', 'window', 'Look ahead (words)')}
      </div>

      <div className="st-rule" role="group" aria-labelledby={`${id}-long-paragraphs`}>
        <h4 id={`${id}-long-paragraphs`}>Long paragraphs (advice)</h4>
        <div className="field">{ruleSwitch('long-paragraphs', 'Point out very long paragraphs')}</div>
        {number('long-paragraphs', 'maxWords', 'Longest paragraph (words)')}
      </div>

      <div className="st-rule" role="group" aria-labelledby={`${id}-isolated-lines`}>
        <h4 id={`${id}-isolated-lines`}>Run of short lines (advice)</h4>
        <div className="field">{ruleSwitch('isolated-lines', 'Point out many one-line paragraphs in a row')}</div>
        {number('isolated-lines', 'minRun', 'Shortest run (lines)')}
      </div>
    </div>
  );
}

/** A book's row: reads the effective settings (GET /api/preferences?book=) and saves a change. @param {{ book: { id: string, title: string }, rev: number, onSave: (r: { ok: boolean, message?: string }, what: string) => void }} props */
function BookStyle({ book, rev, onSave }) {
  const { data } = useApi(`/api/preferences?book=${encodeURIComponent(book.id)}`, String(rev));
  const [busy, setBusy] = useState(false);
  return (
    <StyleBookControls
      book={book}
      style={styleOf(data?.effective?.checks?.style)}
      busy={busy || data === null}
      onChange={async (patch, done) => {
        setBusy(true);
        onSave(await saveStyle(book.id, patch), done);
        setBusy(false);
      }}
    />
  );
}

/**
 * The section from what the server answered (also used by tests).
 * @param {{ books: { id: string, title: string }[], status?: string | null, rev?: number, onSave?: (r: { ok: boolean, message?: string }, what: string) => void }} props
 */
export function StyleSettingsView({ books, status = null, rev = 0, onSave = () => {} }) {
  return (
    <section aria-labelledby="style-checks-heading" className="pref-section">
      <h2 id="style-checks-heading">Style checks</h2>
      <p className="muted">
        Style checks run on this computer and nothing is sent anywhere. They give advice and never change your text until you choose a replacement. The rules are part of StoryForge: a book&apos;s settings can
        switch them on and off and change their options, but cannot add rules. Settings are saved per book, in the book (book.md).
      </p>
      {books.length === 0 ? <p className="muted">No books yet.</p> : books.map((b) => <BookStyle key={b.id} book={b} rev={rev} onSave={onSave} />)}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

/** Settings -> Style checks. */
export function StyleSettings() {
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const { data: books } = useApi('/api/books');
  const list = (Array.isArray(books) ? books : []).map((/** @type {any} */ b) => ({ id: b.id, title: b.title ?? b.slug ?? b.id }));
  return (
    <StyleSettingsView
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
