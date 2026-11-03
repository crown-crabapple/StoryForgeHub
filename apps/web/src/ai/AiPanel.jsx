// The AI workshop chat panel (right side). Preview shows the exact request; Send sends exactly that; the reply is shown as Markdown through the same safe
// renderer as notes and is never written to the book.
import { useState } from 'react';
import { NoteProse } from '../notes/NoteProse.jsx';
import { FilePicker } from './FilePicker.jsx';
import { hostOf } from './model.js';
import { CloudConfirm, ContextPreview, LocalityBadge, StreamingReply, TokensLine } from './parts.jsx';
import { useExchange } from './useExchange.js';

/**
 * @param {{ book: any, active: any, records: boolean, scene: { id: string, title: string, path: string } | null, onClose: () => void }} props
 */
export function AiPanel({ book, active, records, scene, onClose }) {
  const ex = useExchange(book.id);
  const [files, setFiles] = useState(/** @type {{ path: string, title: string }[]} */ (scene ? [{ path: scene.path, title: scene.title }] : []));
  const [instruction, setInstruction] = useState('');
  const [includeContext, setIncludeContext] = useState(false);

  // the open scene is preselected (and follows the author to another scene): state is adjusted while rendering, when the scene changes
  const sceneKey = `${scene?.id ?? ''}|${scene?.path ?? ''}`;
  const [forScene, setForScene] = useState(sceneKey);
  if (forScene !== sceneKey) {
    setForScene(sceneKey);
    setFiles(scene ? [{ path: scene.path, title: scene.title }] : []);
    ex.reset();
  }

  const edit = (fn) => {
    fn();
    ex.reset();
  };
  const canPreview = instruction.trim() !== '' && !ex.busy;
  const host = hostOf(active.baseUrl);

  return (
    <aside className="ai-panel" aria-label="AI workshop">
      <header className="ai-panel-head">
        <h2>AI workshop</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="ai-provider">
        <LocalityBadge locality={active.locality} host={host} /> {active.name} · {active.model}
      </p>
      <p className="muted">Nothing leaves your computer until you click Send. Replies are shown here only; nothing is written to your book.</p>

      <section aria-label="Context files">
        <h3>Context</h3>
        {files.length === 0 ? (
          <p className="muted">No files. The model will see only your instruction.</p>
        ) : (
          <ul className="ai-chosen">
            {files.map((f) => (
              <li key={f.path}>
                <span>{f.title || f.path}</span>{' '}
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
        <label className="ai-label" htmlFor="ai-instruction">
          Instruction
        </label>
        <textarea id="ai-instruction" rows={4} value={instruction} onChange={(e) => edit(() => setInstruction(e.target.value))} placeholder="Ask about this scene, or for ideas" />
      </div>

      <div className="ai-actions">
        <button type="button" className="btn" disabled={!canPreview} onClick={() => ex.preview({ task: 'chat', files: files.map((f) => f.path), instruction })}>
          Preview context
        </button>
        <button type="button" className="btn btn-primary" disabled={!ex.pkg || ex.busy} onClick={() => ex.send({ includeContext })}>
          Send
        </button>
      </div>
      {records && (
        <label className="ai-check">
          <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} /> Include the full context in the saved record
        </label>
      )}
      {ex.busy && !ex.streaming && <p role="status">Working…</p>}
      {ex.streaming && <StreamingReply text={ex.streamText} onCancel={ex.cancel} />}
      {ex.error && (
        <p role="alert" className="form-error">
          {ex.error}
        </p>
      )}
      {ex.pkg && <ContextPreview pkg={ex.pkg} />}
      {ex.result && (
        <section className="ai-reply" aria-label="Reply">
          <h3>Reply</h3>
          <NoteProse source={ex.result.reply} notePath="" bookId={book.id} />
          <TokensLine tokens={ex.result.tokens} />
          {ex.result.record && <p className="muted">Saved as {ex.result.record.path}</p>}
        </section>
      )}
      {ex.pendingCloud && ex.pkg && (
        <CloudConfirm bookId={book.id} host={host} tokens={ex.pkg.tokens.estimate} onConfirm={() => ex.confirmCloud({ includeContext })} onCancel={ex.cancelCloud} />
      )}
    </aside>
  );
}
