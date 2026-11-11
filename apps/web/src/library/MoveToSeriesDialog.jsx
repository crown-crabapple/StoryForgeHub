import { useState } from 'react';
import { postJson } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';

/** The fields an API error can name; an error naming anything else is shown at the top of the form. */
const FIELDS = ['seriesSlug', 'seriesNumber'];

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="field-error">
      {message}
    </p>
  );
}

/**
 * The Move to series dialog for a standalone book: pick an existing series and, optionally, the book's number in it. Moving goes to
 * POST /api/books/:id/move-to-series. The server's message is shown on a refusal; a warning on success is shown before the dialog closes.
 * @param {{
 *   book: { id: string, title: string },
 *   series: { slug: string, title: string | null }[],
 *   onClose: () => void,
 *   onMoved?: (result: { ok: true, bookId: string, path: string, seriesSlug: string, seriesNumber: number, warning?: string }) => void,
 *   error?: { code?: string, field?: string | null, message?: string } | null,
 * }} props  `error` is the error to show when the dialog opens (the dialog keeps its own after that).
 */
export function MoveToSeriesDialog({ book, series, onClose, onMoved, error = null }) {
  const [seriesSlug, setSeriesSlug] = useState('');
  const [seriesNumber, setSeriesNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState(error);
  const [missing, setMissing] = useState(false);
  const [moved, setMoved] = useState(null);

  const clearField = (field) => setApiError((e) => (e && e.field === field ? null : e));
  const knownField = apiError && FIELDS.includes(apiError.field) ? apiError.field : null;
  const message = (field) => (knownField === field ? apiError.message || 'That value cannot be used.' : null);
  const problems = {
    seriesSlug: message('seriesSlug') ?? (missing ? 'Pick a series.' : null),
    seriesNumber: message('seriesNumber'),
  };
  const general = apiError && !knownField ? apiError.message || 'The book could not be moved.' : null;
  const describe = (field) => (problems[field] ? { 'aria-invalid': 'true', 'aria-describedby': `mv-${field}-error` } : {});

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (seriesSlug === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setApiError(null);
    const body = { seriesSlug };
    if (seriesNumber !== '') body.seriesNumber = Number(seriesNumber);
    try {
      const { json } = await postJson(`/api/books/${encodeURIComponent(book.id)}/move-to-series`, body);
      if (json?.ok) {
        if (json.warning) {
          setMoved(json);
          setBusy(false);
        } else {
          onMoved?.(json);
        }
        return;
      }
      setApiError(json && typeof json === 'object' ? { ...json, message: json.message || 'The book could not be moved.' } : { message: 'The book could not be moved.' });
    } catch {
      setApiError({ message: 'StoryForge could not be reached. Try again in a moment.' });
    }
    setBusy(false);
  }

  if (moved) {
    return (
      <Dialog label="Move to series" onClose={() => onMoved?.(moved)} className="move-to-series-dialog">
        <h2>Move to series</h2>
        <p role="status">{book.title} is now in the series.</p>
        <p role="alert" className="form-error">
          {moved.warning}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => onMoved?.(moved)}>
            Close
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog label="Move to series" onClose={onClose} className="move-to-series-dialog">
      <h2>Move to series</h2>
      <p className="secondary">Put &ldquo;{book.title}&rdquo; into a series. Its folder moves into the series folder.</p>
      <form onSubmit={submit} noValidate>
        {general && (
          <p role="alert" className="form-error">
            {general}
          </p>
        )}

        <div className="field">
          <label htmlFor="mv-series">Series</label>
          <select
            id="mv-series"
            value={seriesSlug}
            required
            onChange={(e) => {
              setSeriesSlug(e.target.value);
              setMissing(false);
              clearField('seriesSlug');
              clearField('seriesNumber');
            }}
            {...describe('seriesSlug')}
          >
            <option value="">Choose a series</option>
            {series.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.title ?? s.slug}
              </option>
            ))}
          </select>
          <FieldError id="mv-seriesSlug-error" message={problems.seriesSlug} />
          {series.length === 0 && <p className="secondary field-hint">There is no series yet. Create one from the Library page first.</p>}
        </div>

        <div className="field">
          <label htmlFor="mv-number">Number in series</label>
          <input
            id="mv-number"
            type="number"
            min={1}
            step={1}
            value={seriesNumber}
            placeholder="Next number"
            onChange={(e) => {
              setSeriesNumber(e.target.value);
              clearField('seriesNumber');
            }}
            {...describe('seriesNumber')}
          />
          <FieldError id="mv-seriesNumber-error" message={problems.seriesNumber} />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Moving…' : 'Move book'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
