import { useId, useState } from 'react';
import { useApi } from '../api.js';
import { explainCodexFailure } from '../codex/requests.js';
import { Dialog } from '../shell/Dialog.jsx';
import { send } from '../structure/helpers.js';
import { LabelChip } from './LabelChip.jsx';
import { SHARED_NOTICE, contrastCheck, isHexColor } from './model.js';

let rowKey = 0;
const nextKey = () => `l${rowKey++}`;
const enc = encodeURIComponent;

/** The request that saves one scope's label list. @param {string} bookId @param {'book' | 'series'} scope @param {{ name: string, color: string }[]} labels */
export const labelsRequest = (bookId, scope, labels) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/labels`, body: { scope, labels } });

/**
 * What is wrong with an edited list, in plain words, or null: an empty or repeated name, a colour that is not #RRGGBB, or a colour that is new or changed and too dark
 * to see on the dark background (a colour the file already had is only reported, never blocks saving).
 * @param {{ name: string, color: string }[]} rows @param {{ name: string, color: string | null }[]} saved
 */
export function labelsProblem(rows, saved) {
  const seen = new Set();
  for (const r of rows) {
    const name = r.name.trim();
    if (name === '') return 'Every label needs a name.';
    if (seen.has(name.toLowerCase())) return `The label "${name}" is listed twice. Names are compared ignoring capitals.`;
    seen.add(name.toLowerCase());
    if (!isHexColor(r.color)) return `The colour of "${name}" must be written #RRGGBB.`;
    const was = saved.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const unchanged = was && (was.color ?? '').toLowerCase() === r.color.toLowerCase();
    if (!unchanged && !contrastCheck(r.color).ok) return `The colour of "${name}" is too dark to see on the dark background. Choose a lighter one.`;
  }
  return null;
}

/** One list of labels (a book's or its series'): rows, the contrast check of each colour, Add, Remove and Save. */
function LabelSection({ bookId, scope, title, saved, notice, onSaved }) {
  const id = useId();
  const [rows, setRows] = useState(() => saved.map((l) => ({ key: nextKey(), name: l.name, color: l.color ?? '#888888' })));
  const [status, setStatus] = useState(null); // { kind: 'ok' | 'error', text }
  const [busy, setBusy] = useState(false);
  const patch = (key, p) => {
    setStatus(null);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  };
  const problem = labelsProblem(rows, saved);
  const dirty = JSON.stringify(rows.map((r) => [r.name.trim(), r.color.toUpperCase()])) !== JSON.stringify(saved.map((l) => [l.name.trim(), (l.color ?? '').toUpperCase()]));

  async function save(e) {
    e.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    const r = labelsRequest(bookId, scope, rows.map((x) => ({ name: x.name.trim(), color: x.color.toUpperCase() })));
    const res = await send(r.url, r.body);
    setBusy(false);
    if (res.status === 200) {
      setStatus({ kind: 'ok', text: 'Saved.' });
      onSaved?.();
    } else setStatus({ kind: 'error', text: explainCodexFailure(res.status, res.json) });
  }

  return (
    <form className="label-section" onSubmit={save} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{title}</h3>
      {notice && (
        <p className="muted" role="note">
          {notice}
        </p>
      )}
      {rows.length === 0 && <p className="muted">No labels yet.</p>}
      {rows.map((r, i) => {
        const check = contrastCheck(r.color);
        const was = saved.find((s) => s.name.toLowerCase() === r.name.trim().toLowerCase());
        const legacy = was && (was.color ?? '').toLowerCase() === r.color.toLowerCase();
        return (
          <div className="label-row" key={r.key}>
            <div className="label-row-fields">
              <input type="text" className="form-input" aria-label={`Name of label ${i + 1}`} value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} autoComplete="off" maxLength={60} />
              <input
                type="color"
                className="label-color"
                aria-label={`Colour picker for ${r.name || `label ${i + 1}`}`}
                value={isHexColor(r.color) ? r.color.toLowerCase() : '#888888'}
                onChange={(e) => patch(r.key, { color: e.target.value.toUpperCase() })}
              />
              <input
                type="text"
                className="form-input label-hex"
                aria-label={`Colour of ${r.name || `label ${i + 1}`} (#RRGGBB)`}
                aria-describedby={`${id}-c${r.key}`}
                aria-invalid={check.ok ? undefined : 'true'}
                value={r.color}
                onChange={(e) => patch(r.key, { color: e.target.value.trim() })}
                autoComplete="off"
                spellCheck={false}
                maxLength={7}
              />
              <LabelChip name={r.name.trim() || 'Preview'} defs={isHexColor(r.color) ? [{ name: r.name.trim() || 'Preview', color: r.color }] : null} />
              <button type="button" className="btn row-button" aria-label={`Remove label ${r.name || i + 1}`} onClick={() => {
                  setStatus(null);
                  setRows((rs) => rs.filter((x) => x.key !== r.key));
                }}>
                Remove
              </button>
            </div>
            <p id={`${id}-c${r.key}`} className={check.ok ? 'muted label-contrast' : legacy ? 'label-contrast label-contrast-warn' : 'label-contrast label-contrast-bad'} data-contrast={check.ok ? 'ok' : 'low'}>
              {check.text}
            </p>
          </div>
        );
      })}
      <div className="label-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setStatus(null);
            setRows((rs) => [...rs, { key: nextKey(), name: '', color: '#C98BDB' }]);
          }}
        >
          Add a label
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !dirty || Boolean(problem)}>
          Save {scope === 'series' ? 'series labels' : 'labels'}
        </button>
      </div>
      {problem && dirty && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {status && (
        <p role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind === 'error' ? 'error' : 'muted'}>
          {status.text}
        </p>
      )}
    </form>
  );
}

/**
 * The label manager (contract M07-J01 section 7): the labels of this book and, in a series, of the series: name and colour, with the contrast check against
 * the dark background. Labels are for finding things; they never change the order or the canon. A series' labels apply to every book in the series.
 * @param {{ bookId: string, onClose: () => void, data?: any, onSaved?: () => void }} props `data` is GET /labels (loaded here when it is not given)
 */
export function LabelManager({ bookId, onClose, data = null, onSaved }) {
  const loaded = useApi(data ? null : `/api/books/${enc(bookId)}/labels`);
  const got = data ?? loaded.data;
  return (
    <Dialog label="Labels" onClose={onClose} className="label-manager">
      <h2>Labels</h2>
      <p className="muted">Labels help you find scenes and entries. They never change the order of the book or what is canon.</p>
      {!got && loaded.loading && (
        <p role="status" className="muted">
          Loading…
        </p>
      )}
      {!got && loaded.error && (
        <p role="alert" className="error">
          {loaded.error}
        </p>
      )}
      {got && <LabelSection bookId={bookId} scope="book" title="This book" saved={got.book.labels} onSaved={onSaved} />}
      {got?.series && <LabelSection bookId={bookId} scope="series" title={`Series: ${got.series.title ?? got.series.slug}`} saved={got.series.labels} notice={SHARED_NOTICE} onSaved={onSaved} />}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
