import { useState } from 'react';
import { postJson } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';
import { slugFromTitle } from './NewBookDialog.jsx';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The fields an API error can name; an error naming anything else is shown at the top of the form. */
const FIELDS = ['title', 'slug'];

/** What is wrong with a folder name as typed, in plain words, or null. */
function slugProblem(slug) {
  if (slug === '') return null;
  if (slug.length > 60) return 'The folder name can be at most 60 characters.';
  if (!SLUG_RE.test(slug)) return 'Use only lower-case letters a-z, digits and single hyphens, for example my-series.';
  return null;
}

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="field-error">
      {message}
    </p>
  );
}

/**
 * The New series dialog: a title and an optional folder name. Creating goes to POST /api/series; an error that names a field is shown next to that field.
 * @param {{
 *   onClose: () => void,
 *   onCreated?: (result: { ok: true, seriesId: string, slug: string, path: string }) => void,
 *   error?: { code?: string, field?: string | null, message?: string } | null,
 * }} props  `error` is the error to show when the dialog opens (the dialog keeps its own after that).
 */
export function NewSeriesDialog({ onClose, onCreated, error = null }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState(error);
  const [titleMissing, setTitleMissing] = useState(false);

  const clearField = (field) => setApiError((e) => (e && e.field === field ? null : e));
  const knownField = apiError && FIELDS.includes(apiError.field) ? apiError.field : null;
  const message = (field) => (knownField === field ? apiError.message || 'That value cannot be used.' : null);
  const problems = {
    title: message('title') ?? (titleMissing ? 'Give the series a title.' : null),
    slug: slugProblem(slug) ?? message('slug'),
  };
  const general = apiError && !knownField ? apiError.message || 'The series could not be created.' : null;
  const describe = (field) => (problems[field] ? { 'aria-invalid': 'true', 'aria-describedby': `ns-${field}-error` } : {});

  function onTitle(value) {
    setTitle(value);
    setTitleMissing(false);
    clearField('title');
    if (!slugTouched) {
      setSlug(slugFromTitle(value));
      clearField('slug');
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (title.trim() === '') {
      setTitleMissing(true);
      return;
    }
    if (slugProblem(slug)) return;
    setBusy(true);
    setApiError(null);
    const body = { title };
    if (slug !== '') body.slug = slug;
    try {
      const { json } = await postJson('/api/series', body);
      if (json?.ok) {
        onCreated?.(json);
        return;
      }
      setApiError(json && typeof json === 'object' ? json : { message: 'The series could not be created.' });
    } catch {
      setApiError({ message: 'StoryForge could not be reached. Try again in a moment.' });
    }
    setBusy(false);
  }

  return (
    <Dialog label="New series" onClose={onClose} className="new-series-dialog">
      <h2>New series</h2>
      <form onSubmit={submit} noValidate>
        {general && (
          <p role="alert" className="form-error">
            {general}
          </p>
        )}

        <div className="field">
          <label htmlFor="ns-title">Title</label>
          <input id="ns-title" type="text" value={title} required maxLength={120} autoComplete="off" onChange={(e) => onTitle(e.target.value)} {...describe('title')} />
          <FieldError id="ns-title-error" message={problems.title} />
        </div>

        <div className="field">
          <label htmlFor="ns-slug">Folder name</label>
          <input
            id="ns-slug"
            type="text"
            value={slug}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
              clearField('slug');
            }}
            {...describe('slug')}
          />
          <FieldError id="ns-slug-error" message={problems.slug} />
          {!problems.slug && <p className="secondary field-hint">The series&rsquo; folder, filled in from the title. You can change it.</p>}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create series'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
