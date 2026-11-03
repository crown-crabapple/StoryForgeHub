import { useId, useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { send } from '../structure/helpers.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A template name from a title: lower-case letters and digits with single hyphens, at most 60 characters. @param {string} title */
export function templateNameOf(title) {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Save as template… (contract M07-J01 section 7): the structure of this book (acts, chapters, scene titles, types, labels, planning documents and threads) becomes
 * a template in the library's _templates/ folder, offered in the New book dialog. No story text is kept. A name that is already taken is refused; nothing is changed then.
 * @param {{ bookId: string, bookTitle?: string | null, onClose: () => void }} props
 */
export function SaveAsTemplateDialog({ bookId, bookTitle = null, onClose }) {
  const id = useId();
  const [title, setTitle] = useState(bookTitle ? `${bookTitle} structure` : '');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { field?: 'title' | 'name', message }
  const [done, setDone] = useState(null);
  const shownName = nameTouched ? name : templateNameOf(title);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (title.trim() === '') return setError({ field: 'title', message: 'Give the template a title.' });
    if (!NAME_RE.test(shownName) || shownName.length > 60) return setError({ field: 'name', message: 'The template name can use only lower-case letters a-z, digits and single hyphens (1 to 60 characters).' });
    setBusy(true);
    setError(null);
    const r = await send(`/api/books/${encodeURIComponent(bookId)}/save-as-template`, { name: shownName, title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
    setBusy(false);
    if (r.status === 201) return setDone(r.json);
    const field = r.json?.field === 'name' || r.json?.field === 'title' ? r.json.field : null;
    return setError({ field, message: r.json?.message ?? (r.status === 0 ? 'The server could not be reached.' : `The template was not saved (${r.json?.code ?? r.status}).`) });
  }

  if (done) {
    return (
      <Dialog label="Save as template" onClose={onClose}>
        <h2>Template saved</h2>
        <p role="status">
          The template <strong>{done.name}</strong> is in <code>{done.path}</code>. It is offered in the New book dialog, after the built-in templates.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
    );
  }
  const problem = (field) => (error?.field === field ? error.message : null);
  const general = error && !error.field ? error.message : null;
  return (
    <Dialog label="Save as template" onClose={onClose}>
      <h2>Save as template</h2>
      <p className="muted">Keeps the acts, chapters, scene titles, types, labels, planning documents and threads. Leaves out all story text, entries, receipts and notes.</p>
      <form onSubmit={submit} noValidate>
        {general && (
          <p role="alert" className="form-error">
            {general}
          </p>
        )}
        <div className="field">
          <label htmlFor={`${id}-title`}>Title</label>
          <input id={`${id}-title`} type="text" value={title} maxLength={120} autoComplete="off" onChange={(e) => setTitle(e.target.value)} aria-invalid={problem('title') ? 'true' : undefined} aria-describedby={problem('title') ? `${id}-title-error` : undefined} />
          {problem('title') && (
            <p id={`${id}-title-error`} role="alert" className="field-error">
              {problem('title')}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-name`}>Template name</label>
          <input
            id={`${id}-name`}
            type="text"
            value={shownName}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            aria-invalid={problem('name') ? 'true' : undefined}
            aria-describedby={problem('name') ? `${id}-name-error` : undefined}
          />
          {problem('name') ? (
            <p id={`${id}-name-error`} role="alert" className="field-error">
              {problem('name')}
            </p>
          ) : (
            <p className="secondary field-hint">The name of the template&rsquo;s folder in _templates/. It cannot be the name of one you already have.</p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-desc`}>Description (optional)</label>
          <textarea id={`${id}-desc`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
