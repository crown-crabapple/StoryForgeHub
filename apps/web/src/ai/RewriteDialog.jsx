// "Rewrite with AI..." from an editor selection: instruction, preview, send, then the result as a diff against the selection.
// Nothing is written until Apply; Discard (or closing) writes nothing. Apply can be undone.
import { useState } from 'react';
import { useEditorBridge } from '../editor/bridge.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { FilePicker } from './FilePicker.jsx';
import { hostOf } from './model.js';
import { CloudConfirm, ContextPreview, DiffView, LocalityBadge } from './parts.jsx';
import { aiRequest, aiUrl, problemText } from './requests.js';
import { useExchange } from './useExchange.js';

/**
 * @param {{ book: any, active: any, records: boolean, scene: { id: string, title: string, path: string } | null,
 *   rewrite: { sceneId: string, from: number, to: number, text: string }, onClose: () => void }} props
 */
export function RewriteDialog({ book, active, records, scene, rewrite, onClose }) {
  const bridge = useEditorBridge();
  const ex = useExchange(book.id);
  const [files, setFiles] = useState(/** @type {{ path: string, title: string }[]} */ (scene ? [{ path: scene.path, title: scene.title }] : []));
  const [instruction, setInstruction] = useState('');
  const [includeContext, setIncludeContext] = useState(false);
  const [applied, setApplied] = useState(/** @type {{ opId: string | null } | null} */ (null));
  const [note, setNote] = useState(/** @type {string | null} */ (null));
  const [working, setWorking] = useState(false);
  const host = hostOf(active.baseUrl);
  const original = ex.pkg?.selection?.text ?? rewrite.text;

  const edit = (fn) => {
    fn();
    ex.reset();
  };

  async function preview() {
    const pkg = await ex.preview({ task: 'rewrite', files: files.map((f) => f.path), selection: { sceneId: rewrite.sceneId, from: rewrite.from, to: rewrite.to }, instruction });
    if (pkg && pkg.selection?.text !== rewrite.text) {
      ex.reset();
      ex.setError('The saved scene is not the same as what you see in the editor. Wait for it to finish saving, then try again.');
    }
  }

  async function discardAndClose() {
    if (ex.pkg && !applied) await aiRequest('POST', aiUrl.discard(book.id), { contextId: ex.pkg.contextId }).catch(() => {});
    onClose();
  }

  async function apply() {
    setWorking(true);
    setNote(null);
    try {
      const r = await aiRequest('POST', aiUrl.apply(book.id), { contextId: ex.pkg.contextId });
      if (r.status === 200) {
        setApplied({ opId: r.json.opId ?? null });
        await bridge.current()?.reload?.();
      } else ex.setError(problemText(r));
    } catch {
      ex.setError('The server could not be reached.');
    }
    setWorking(false);
  }

  async function undo() {
    if (!applied?.opId) return;
    setWorking(true);
    try {
      const r = await aiRequest('POST', aiUrl.undo(book.id, applied.opId), {});
      if (r.status === 200) {
        setApplied(null);
        setNote('Undone. The scene is exactly as it was before.');
        await bridge.current()?.reload?.();
      } else setNote('The rewrite could not be undone automatically (the scene changed since). Use the scene revisions to go back.');
    } catch {
      setNote('The server could not be reached.');
    }
    setWorking(false);
  }

  const replacement = ex.result?.replacement ?? null;
  return (
    <Dialog label="Rewrite with AI" onClose={discardAndClose} className="ai-rewrite">
      <h2>Rewrite with AI</h2>
      <p>
        <LocalityBadge locality={active.locality} host={host} /> {active.name} · {active.model}
      </p>
      <section aria-label="Selected text">
        <h3>Selected text</h3>
        <pre className="ai-selection">{rewrite.text}</pre>
      </section>

      {!replacement && (
        <>
          <section aria-label="Context files">
            <h3>Also give the model</h3>
            {files.length === 0 ? (
              <p className="muted">Nothing else: only the selected text and your instruction.</p>
            ) : (
              <ul className="ai-chosen">
                {files.map((f) => (
                  <li key={f.path}>
                    {f.title || f.path}{' '}
                    <button type="button" className="btn" aria-label={`Remove ${f.title || f.path}`} onClick={() => edit(() => setFiles((all) => all.filter((x) => x.path !== f.path)))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FilePicker book={book} chosen={files.map((f) => f.path)} onAdd={(f) => edit(() => setFiles((all) => [...all, f]))} />
          </section>
          <div className="ai-field">
            <label className="ai-label" htmlFor="ai-rewrite-instruction">
              Instruction
            </label>
            <textarea id="ai-rewrite-instruction" rows={3} value={instruction} onChange={(e) => edit(() => setInstruction(e.target.value))} placeholder="For example: tighter, in the same voice" />
          </div>
          {records && (
            <label className="ai-check">
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} /> Include the full context in the saved record
            </label>
          )}
          {ex.pkg && <ContextPreview pkg={ex.pkg} />}
        </>
      )}

      {replacement && (
        <section aria-label="Result">
          <h3>Proposed rewrite</h3>
          <DiffView before={original} after={replacement} />
          {applied && <p role="status">Applied to the scene.</p>}
          {!applied && ex.result?.suggestion && (
            <p className="muted">
              Saved as a suggestion: the scene is unchanged. Apply accepts every change; to take only some, choose Review changes and use Suggestions in the right panel.
            </p>
          )}
        </section>
      )}

      {(ex.busy || working) && <p role="status">Working…</p>}
      {ex.error && (
        <p role="alert" className="form-error">
          {ex.error}
        </p>
      )}
      {note && <p role="status">{note}</p>}

      <div className="dialog-actions">
        {!replacement && (
          <>
            <button type="button" className="btn" disabled={instruction.trim() === '' || ex.busy} onClick={preview}>
              Preview context
            </button>
            <button type="button" className="btn btn-primary" disabled={!ex.pkg || ex.busy} onClick={() => ex.send({ includeContext })}>
              Send
            </button>
            <button type="button" className="btn" onClick={discardAndClose}>
              Cancel
            </button>
          </>
        )}
        {replacement && !applied && (
          <>
            <button type="button" className="btn btn-primary" disabled={working} onClick={apply}>
              Apply
            </button>
            {ex.result?.suggestion && (
              <button type="button" className="btn" disabled={working} onClick={onClose}>
                Review changes
              </button>
            )}
            <button type="button" className="btn" disabled={working} onClick={discardAndClose}>
              Discard
            </button>
          </>
        )}
        {replacement && applied && (
          <>
            {applied.opId && (
              <button type="button" className="btn" disabled={working} onClick={undo}>
                Undo
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
      {ex.pendingCloud && ex.pkg && <CloudConfirm bookId={book.id} host={host} tokens={ex.pkg.tokens.estimate} onConfirm={() => ex.confirmCloud({ includeContext })} onCancel={ex.cancelCloud} />}
    </Dialog>
  );
}
