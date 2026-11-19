import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { ValidationPanel } from './ValidationPanel.jsx';
import { cancelValidation, pollValidation, saveValidateChoice, startValidation, validationUrls } from './validation.js';
import { EVIDENCE_WARNING, EXPORT_FORMATS, INCLUDE_OPTIONS, PAGE_SIZES, PLANNING_EXPORT_HINT, exportUrl, fetchDownload, planningExportUrl, saveBlob, statusesOf } from './requests.js';

const EXTENSION = { markdown: 'md', docx: 'docx', epub: 'epub', pdf: 'pdf' };

/**
 * The Export dialog: a format, whether scenes get titles, which statuses to leave out, the PDF page size. Export downloads the file; nothing in the
 * book is changed.
 * With EPUB chosen it also offers "Validate with EPUBCheck" (M13-J04): ticked, the dialog stays open while the EPUB is checked and then shows the outcome, the messages and the downloads.
 * @param {{ book: { id: string, slug?: string | null, acts?: any[] }, onClose: () => void, fetchImpl?: typeof fetch, initialValidate?: boolean, initialFormat?: string, pollMs?: number, sleep?: (ms: number) => Promise<void> }} props
 *   `book` is the book detail from GET /api/books/:id (its scenes give the statuses to offer); `initialValidate` is the book's remembered `checks.epub.validate`.
 */
export function ExportDialog({ book, onClose, fetchImpl, initialValidate = false, initialFormat = 'docx', pollMs, sleep }) {
  const [format, setFormat] = useState(initialFormat);
  const [sceneTitles, setSceneTitles] = useState(false);
  const [leaveOut, setLeaveOut] = useState([]);
  const [page, setPage] = useState('letter');
  const [include, setInclude] = useState('manuscript');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [validate, setValidate] = useState(initialValidate === true);
  const [check, setCheck] = useState(/** @type {{ phase: 'running' | 'done', id: string | null, job: any, cancelling: boolean } | null} */ (null));
  const [note, setNote] = useState(/** @type {string | null} */ (null));
  const live = useRef(new AbortController());
  const statuses = statusesOf(book);
  const checking = format === 'epub' && validate && include === 'manuscript';
  const running = check?.phase === 'running';
  useEffect(() => {
    const ctrl = live.current;
    return () => ctrl.abort();
  }, []);

  async function download(url, fallbackName) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await fetchDownload(url, fallbackName, fetchImpl);
    setBusy(false);
    if (!r.ok) {
      setProblem(r.message);
      return;
    }
    saveBlob(r.blob, r.filename);
    onClose();
  }

  /** Remember the choice for this book; a failure is said, the choice still applies to this export. @param {boolean} on */
  async function chooseValidate(on) {
    setValidate(on);
    setNote(null);
    const r = await saveValidateChoice(book.id, on, fetchImpl);
    if (!r.ok) setNote(r.message ?? null);
  }

  /** Build the EPUB, check it, and show the outcome here; the dialog stays open. */
  async function runCheck() {
    if (busy || running) return;
    setProblem(null);
    setCheck({ phase: 'running', id: null, job: null, cancelling: false });
    const started = await startValidation(book.id, { sceneTitles, excludeStatuses: leaveOut }, fetchImpl);
    if (live.current.signal.aborted) return;
    if (!started.ok) {
      setCheck(null);
      setProblem(started.message);
      return;
    }
    setCheck({ phase: 'running', id: started.id, job: null, cancelling: false });
    const done = await pollValidation(book.id, started.id, { fetchImpl, signal: live.current.signal, intervalMs: pollMs, sleep });
    if (done === null) return;
    if (!done.ok) {
      setCheck(null);
      setProblem(done.message);
      return;
    }
    setCheck({ phase: 'done', id: started.id, job: done.job, cancelling: false });
  }

  async function cancelCheck() {
    if (!check?.id) return;
    setCheck((c) => (c ? { ...c, cancelling: true } : c));
    await cancelValidation(book.id, check.id, fetchImpl);
  }

  /** Download a file of the finished check; the dialog stays open. @param {'file' | 'report'} which @param {string} fallbackName */
  async function downloadCheck(which, fallbackName) {
    if (busy || !check?.id) return;
    setBusy(true);
    setProblem(null);
    const r = await fetchDownload(validationUrls(book.id)[which](check.id), fallbackName, fetchImpl);
    setBusy(false);
    if (!r.ok) setProblem(r.message);
    else saveBlob(r.blob, r.filename);
  }

  /** Closing while a check runs stops it. */
  function close() {
    if (running && check?.id) void cancelValidation(book.id, check.id, fetchImpl);
    onClose();
  }

  function submit(e) {
    e.preventDefault();
    if (checking) return runCheck();
    return download(exportUrl(book.id, { format, sceneTitles, excludeStatuses: leaveOut, page, include }), include === 'evidence' ? `${book.slug ?? 'manuscript'}-evidence.zip` : `${book.slug ?? 'manuscript'}.${EXTENSION[format]}`);
  }

  return (
    <Dialog label="Export" onClose={close} className="export-dialog">
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

        {format === 'epub' && (
          <div className="field">
            <label className="choice">
              <input type="checkbox" name="export-validate" checked={validate} disabled={running} aria-describedby="export-validate-hint" onChange={(e) => chooseValidate(e.target.checked)} />
              <span>Validate with EPUBCheck</span>
            </label>
            <p className="secondary field-hint" id="export-validate-hint">
              {include === 'manuscript'
                ? 'Checks the EPUB against the EPUB standard on this computer, using the Java and EPUBCheck you installed. Remembered for this book.'
                : 'Only the manuscript EPUB is checked. Choose "Manuscript only" to validate.'}
            </p>
            {note && (
              <p role="alert" className="field-error">
                {note}
              </p>
            )}
          </div>
        )}

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

        <div className="field export-planning">
          <h3>Planning notes</h3>
          <p className="secondary field-hint" id="export-planning-hint">
            {PLANNING_EXPORT_HINT}
          </p>
          <button type="button" className="btn" aria-describedby="export-planning-hint" disabled={busy} onClick={() => download(planningExportUrl(book.id), `${book.slug ?? 'book'}-planning.zip`)}>
            Planning notes (Markdown zip)
          </button>
        </div>

        {check && (
          <ValidationPanel
            phase={check.phase}
            job={check.job}
            bookId={book.id}
            cancelling={check.cancelling}
            canCancel={check.id !== null}
            busy={busy}
            onCancel={cancelCheck}
            onDownloadFile={() => downloadCheck('file', `${book.slug ?? 'manuscript'}.epub`)}
            onDownloadReport={() => downloadCheck('report', `${book.slug ?? 'manuscript'}-epubcheck-report.json`)}
          />
        )}
        {problem && (
          <p role="alert" className="field-error">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            {check ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || running}>
            {busy ? 'Exporting…' : checking ? (check?.phase === 'done' ? 'Check again' : 'Export and check') : 'Export'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
