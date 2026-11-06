import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';

/**
 * "New structure": pick a template (its beats are previewed before anything is written), name it, then create. `onCreate({ template, name })` resolves to `{ ok: true }`
 * (the container closes the dialog) or `{ ok: false, message }`.
 * @param {{ templates: { id: string, version: number, name: string, description?: string, beats: { name: string, purpose?: string, position?: string }[] }[] | null,
 *   onCreate: (v: { template: string, name: string }) => Promise<any>, onClose: () => void }} props
 */
export function NewStructureDialog({ templates, onCreate, onClose }) {
  const [picked, setPicked] = useState(/** @type {string | null} */ (null));
  const [typed, setTyped] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const list = templates ?? [];
  const template = list.find((t) => t.id === picked) ?? list[0] ?? null;
  const name = typed ?? template?.name ?? '';
  async function submit(e) {
    e.preventDefault();
    if (!template) return;
    if (name.trim() === '') {
      setProblem('Give the structure a name.');
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await onCreate({ template: template.id, name: name.trim() });
    setBusy(false);
    if (r && r.ok === false) setProblem(r.message);
  }
  return (
    <Dialog label="New structure" onClose={onClose}>
      <h2>New structure</h2>
      <form onSubmit={submit}>
        {templates === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <fieldset className="st-templates">
              <legend>Template</legend>
              {list.map((t) => (
                <div key={t.id} className="st-template">
                  <input type="radio" id={`st-template-${t.id}`} name="st-template" value={t.id} checked={template?.id === t.id} onChange={() => setPicked(t.id)} />
                  <label htmlFor={`st-template-${t.id}`}>
                    <span className="st-template-name">{t.name}</span>
                    {t.description ? <span className="muted">{` ${t.description}`}</span> : null}
                  </label>
                </div>
              ))}
            </fieldset>
            {template && (
              <section className="st-preview" aria-labelledby="st-preview-h">
                <h3 id="st-preview-h">{`Beats in ${template.name}`}</h3>
                {template.beats.length === 0 ? (
                  <p className="muted">This template has no beats. You add your own.</p>
                ) : (
                  <ol>
                    {template.beats.map((b) => (
                      <li key={b.name}>
                        <strong>{b.name}</strong>
                        {b.purpose ? ` — ${b.purpose}` : ''}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
            <div className="form-row">
              <label htmlFor="new-structure-name">Name</label>
              <input id="new-structure-name" type="text" value={name} autoComplete="off" onChange={(e) => setTyped(e.target.value)} required />
            </div>
          </>
        )}
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !template}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
