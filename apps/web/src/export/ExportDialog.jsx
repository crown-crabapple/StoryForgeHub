import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { EVIDENCE_WARNING, EXPORT_FORMATS, INCLUDE_OPTIONS, PAGE_SIZES, exportUrl, fetchDownload, saveBlob, statusesOf } from './requests.js';

const EXTENSION = { markdown: 'md', docx: 'docx', epub: 'epub', pdf: 'pdf' };

/**
 * The Export dialog: a format, whether scenes get titles, which statuses to leave out, the PDF page size. Export downloads the file; nothing in the
 * book is changed.
 * @param {{ book: { id: string, slug?: string | null, acts?: any[] }, onClose: () => void, fetchImpl?: typeof fetch }} props
 *   `book` is the book detail from GET /api/books/:id (its scenes give the statuses to offer).
 */
export function ExportDialog({ book, onClose, fetchImpl }) {
  const [format, setFormat] = useState('docx');
  const [sceneTitles, setSceneTitles] = useState(false);
  const [leaveOut, setLeaveOut] = useState([]);
  const [page, setPage] = useState('letter');
  const [include, setInclude] = useState('manuscript');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const statuses = statusesOf(book);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await fetchDownload(exportUrl(book.id, { format, sceneTitles, excludeStatuses: leaveOut, page, include }), include === 'evidence' ? `${book.slug ?? 'manuscript'}-evidence.zip` : `${book.slug ?? 'manuscript'}.${EXTENSION[format]}`, fetchImpl);
    setBusy(false);
    if (!r.ok) {
      setProblem(r.message);
      return;
    }
    saveBlob(r.blob, r.filename);
    onClose();
  }

  return (
    <Dialog label="Export" onClose={onClose} className="export-dialog">
      <h2>Export</h2>
      <form onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend>Format</legend>
          {EXPORT_FORMATS.map((f) => (
            <label key={f.key} className="choice">
              <input type="radio" name="export-format" value={f.key} checked={format === f.key} onChange={() => setFormat(f.key)} />
              <span>
                {f.label} <span className="secondary">{f.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="field">
          <legend>What to include</legend>
          {INCLUDE_OPTIONS.map((o) => (
            <label key={o.key} className="choice">
              <input type="radio" name="export-include" value={o.key} checked={include === o.key} onChange={() => setInclude(o.key)} />
              <span>
                {o.label} <span className="secondary">{o.hint}</span>
              </span>
            </label>
          ))}
          {include === 'evidence' && (
            <p role="note" className="export-warning">
              {EVIDENCE_WARNING}
            </p>
          )}
        </fieldset>

        <div className="field">
          <label className="choice">
            <input type="checkbox" checked={sceneTitles} onChange={(e) => setSceneTitles(e.target.checked)} />
            <span>Include scene titles</span>
          </label>
          <p className="secondary field-hint">Without them, scenes are separated by a scene break (* * *).</p>
        </div>

        <fieldset className="field">
          <legend>Leave out scenes with status…</legend>
          {statuses.map((s) => (
            <label key={s} className="choice">
              <input
                type="checkbox"
                name="export-status"
                value={s}
                checked={leaveOut.includes(s)}
                onChange={(e) => setLeaveOut((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
              />
              <span>{s}</span>
            </label>
          ))}
          <p className="secondary field-hint">Variants and archived scenes are never included.</p>
        </fieldset>

        <div className="field">
          <label htmlFor="export-page">PDF page size</label>
          <select id="export-page" value={page} disabled={format !== 'pdf'} onChange={(e) => setPage(e.target.value)}>
            {PAGE_SIZES.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {problem && (
          <p role="alert" className="field-error">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
