import { useState } from 'react';
import { postJson } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The fields an API error can name; an error naming anything else is shown at the top of the form. */
const FIELDS = ['title', 'slug', 'penName', 'seriesSlug', 'seriesNumber', 'template'];

/** A folder name from a title: lower-case ASCII letters and digits with single hyphens, at most 60 characters. */
export function slugFromTitle(title) {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** What is wrong with a folder name as typed, in plain words, or null. */
function slugProblem(slug) {
  if (slug === '') return null;
  if (slug.length > 60) return 'The folder name can be at most 60 characters.';
  if (!SLUG_RE.test(slug)) return 'Use only lower-case letters a-z, digits and single hyphens, for example my-first-book.';
  return null;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="field-error">
      {message}
    </p>
  );
}

/**
 * The New book dialog: title, folder name, pen name, series, template. Creating goes to POST /api/books;
 * an error that names a field is shown next to that field.
 * @param {{
 *   templates: { name: string, title: string, description: string, beats: string[], chapters: number, scenes: number }[],
 *   series?: { slug: string, title: string | null }[],
 *   penNames?: { name: string, slug: string }[],
 *   onClose: () => void,
 *   onCreated?: (result: { ok: true, bookId: string, path: string }) => void,
 *   error?: { code?: string, field?: string | null, message?: string } | null,
 * }} props  `error` is the error to show when the dialog opens (the dialog keeps its own after that).
 */
export function NewBookDialog({ templates, series = [], penNames = [], onClose, onCreated, error = null }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [penName, setPenName] = useState('');
  const [seriesSlug, setSeriesSlug] = useState('');
  const [seriesNumber, setSeriesNumber] = useState('');
  const [template, setTemplate] = useState(templates[0]?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState(error);
  const [titleMissing, setTitleMissing] = useState(false);

  const clearField = (field) => setApiError((e) => (e && e.field === field ? null : e));
  const knownField = apiError && FIELDS.includes(apiError.field) ? apiError.field : null;
  const message = (field) => (knownField === field ? apiError.message || 'That value cannot be used.' : null);
  const problems = {
    title: message('title') ?? (titleMissing ? 'Give the book a title.' : null),
    slug: slugProblem(slug) ?? message('slug'),
    penName: message('penName'),
    seriesSlug: message('seriesSlug'),
    seriesNumber: message('seriesNumber'),
    template: message('template'),
  };
  const general = apiError && !knownField ? apiError.message || 'The book could not be created.' : null;
  const describe = (field) => (problems[field] ? { 'aria-invalid': 'true', 'aria-describedby': `nb-${field}-error` } : {});

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
    const body = { title, template };
    if (slug !== '') body.slug = slug;
    if (penName !== '') body.penName = penName;
    if (seriesSlug !== '') {
      body.seriesSlug = seriesSlug;
      if (seriesNumber !== '') body.seriesNumber = Number(seriesNumber);
    }
    try {
      const { json } = await postJson('/api/books', body);
      if (json?.ok) {
        onCreated?.(json);
        return;
      }
      setApiError(json && typeof json === 'object' ? json : { message: 'The book could not be created.' });
    } catch {
      setApiError({ message: 'StoryForge could not be reached. Try again in a moment.' });
    }
    setBusy(false);
  }

  return (
    <Dialog label="New book" onClose={onClose} className="new-book-dialog">
      <h2>New book</h2>
      <form onSubmit={submit} noValidate>
        {general && (
          <p role="alert" className="form-error">
            {general}
          </p>
        )}

        <div className="field">
          <label htmlFor="nb-title">Title</label>
          <input id="nb-title" type="text" value={title} required maxLength={120} autoComplete="off" onChange={(e) => onTitle(e.target.value)} {...describe('title')} />
          <FieldError id="nb-title-error" message={problems.title} />
        </div>

        <div className="field">
          <label htmlFor="nb-slug">Folder name</label>
          <input
            id="nb-slug"
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
          <FieldError id="nb-slug-error" message={problems.slug} />
          {!problems.slug && <p className="secondary field-hint">The book&rsquo;s folder, filled in from the title. You can change it.</p>}
        </div>

        <div className="field">
          <label htmlFor="nb-pen">Pen name</label>
          <select
            id="nb-pen"
            value={penName}
            onChange={(e) => {
              setPenName(e.target.value);
              clearField('penName');
            }}
            {...describe('penName')}
          >
            <option value="">None</option>
            {penNames.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <FieldError id="nb-penName-error" message={problems.penName} />
        </div>

        <div className="field">
          <label htmlFor="nb-series">Series</label>
          <select
            id="nb-series"
            value={seriesSlug}
            onChange={(e) => {
              setSeriesSlug(e.target.value);
              clearField('seriesSlug');
              clearField('seriesNumber');
            }}
            {...describe('seriesSlug')}
          >
            <option value="">Standalone</option>
            {series.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.title ?? s.slug}
              </option>
            ))}
          </select>
          <FieldError id="nb-seriesSlug-error" message={problems.seriesSlug} />
        </div>

        {(seriesSlug !== '' || problems.seriesNumber) && (
          <div className="field">
            {seriesSlug !== '' && (
              <>
                <label htmlFor="nb-number">Number in series</label>
                <input
                  id="nb-number"
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
              </>
            )}
            <FieldError id="nb-seriesNumber-error" message={problems.seriesNumber} />
          </div>
        )}

        <fieldset className="field template-field" aria-describedby={problems.template ? 'nb-template-error' : undefined}>
          <legend>Template</legend>
          <ul className="template-cards">
            {templates.map((t) => (
              <li key={t.name} className="template-card" data-selected={template === t.name ? 'true' : 'false'}>
                <label className="template-card-label">
                  <input
                    type="radio"
                    name="template"
                    value={t.name}
                    checked={template === t.name}
                    onChange={() => {
                      setTemplate(t.name);
                      clearField('template');
                    }}
                  />
                  <span className="template-card-body">
                    <strong>{t.title}</strong>
                    <span className="secondary">{t.description}</span>
                    <span className="muted">{`${plural(t.chapters, 'chapter')} · ${plural(t.scenes, 'scene')}`}</span>
                  </span>
                </label>
                <details className="template-beats">
                  <summary>Beats</summary>
                  <ol>
                    {t.beats.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ul>
          <FieldError id="nb-template-error" message={problems.template} />
        </fieldset>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create book'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
