// The two forms of the planning views: a card (new or edit) and a new thread. Each one only collects input; the page sends the request.
// `onSubmit(values)` resolves to { error } (the form stays open and shows it) or { close: true }.
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { STATUSES, slugify } from '../structure/helpers.js';
import { THREAD_KINDS, THREAD_STATES, stateLabel } from './model.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function Row({ label, hint, children }) {
  return (
    <div className="form-row">
      <label>
        <span className="form-label">{label}</span>
        {children}
      </label>
      {hint && <p className="muted form-hint">{hint}</p>}
    </div>
  );
}

/** One paragraph on one line: breaks become spaces. @param {string} text */
export const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

function useSubmit(onSubmit, onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run(values) {
    setBusy(true);
    setError(null);
    const r = await onSubmit(values);
    setBusy(false);
    if (r?.error) setError(r.error);
    else onClose();
  }
  return { busy, error, run };
}

/**
 * A card: "New card" (title and an optional summary; the scene is created with status outline) or "Edit card" (title, summary, status, POV).
 * @param {{ mode: 'new' | 'edit', card?: any, chapterName?: string, characters?: { slug: string, title: string | null }[], onSubmit: (v: any) => Promise<any>, onClose: () => void }} props
 */
export function CardDialog({ mode, card = null, chapterName = '', characters = [], onSubmit, onClose }) {
  const [title, setTitle] = useState(card?.title ?? '');
  const [summary, setSummary] = useState(card?.summary ?? '');
  const [status, setStatus] = useState(card?.status ?? 'outline');
  const [pov, setPov] = useState(card?.pov ?? '');
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const editing = mode === 'edit';
  const heading = editing ? 'Edit card' : 'New card';
  const povKnown = pov === '' || characters.some((c) => c.slug === pov);
  return (
    <Dialog label={heading} onClose={onClose}>
      <h2>{heading}</h2>
      {!editing && chapterName && <p className="muted">In {chapterName}, as the last card. Status: outline.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === '') return setProblem('Give the card a title.');
          setProblem(null);
          return run({ title: title.trim(), summary: oneLine(summary), status, pov });
        }}
      >
        <Row label="Title">
          <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Row>
        <Row label="Summary" hint="One short paragraph. It is kept on one line in the file.">
          <textarea name="summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Row>
        {editing && (
          <>
            <Row label="Status">
              <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="POV">
              <select name="pov" value={pov} onChange={(e) => setPov(e.target.value)}>
                {pov === '' && <option value="">No POV</option>}
                {!povKnown && <option value={pov}>{pov}</option>}
                {characters.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.title ?? c.slug}
                  </option>
                ))}
              </select>
            </Row>
          </>
        )}
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? 'Save' : 'Preview'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * New thread: title, slug (made from the title until you type one), kind and state (planned by default). `takenSlugs`: the slugs entries, threads and events use.
 * @param {{ takenSlugs?: Set<string>, onSubmit: (v: { title: string, slug: string, kind: string, status: string }) => Promise<any>, onClose: () => void }} props
 */
export function NewThreadDialog({ takenSlugs = new Set(), onSubmit, onClose }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [kind, setKind] = useState('subplot');
  const [status, setStatus] = useState('planned');
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const shown = touched ? slug : title.trim() === '' ? '' : slugify(title);
  return (
    <Dialog label="New thread" onClose={onClose}>
      <h2>New thread</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === '') return setProblem('Give the thread a title.');
          if (!SLUG_RE.test(shown) || shown.length > 60) return setProblem('The slug must be lower-case letters, digits and single hyphens (up to 60 characters).');
          if (takenSlugs.has(shown)) return setProblem('That slug is already used by another entry, thread or event. Choose a different one.');
          setProblem(null);
          return run({ title: title.trim(), slug: shown, kind, status });
        }}
      >
        <Row label="Title">
          <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Row>
        <Row label="Slug" hint={`The file is planning/threads/${shown || '<slug>'}.md`}>
          <input
            type="text"
            name="slug"
            value={shown}
            autoComplete="off"
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Row>
        <Row label="Kind">
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {THREAD_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Row>
        <Row label="State">
          <select name="state" value={status} onChange={(e) => setStatus(e.target.value)}>
            {THREAD_STATES.map((s) => (
              <option key={s} value={s}>
                {stateLabel(s)}
              </option>
            ))}
          </select>
        </Row>
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}
