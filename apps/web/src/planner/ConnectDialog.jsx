import { useState } from 'react';
import { chapterShort } from '../planning/model.js';
import { Dialog } from '../shell/Dialog.jsx';
import { BRANCH_RULE, filterNodes, sceneName, validateBranch } from './model.js';
import { RELATIONS, relationLabel } from './requests.js';

const sceneOption = (n) => `${typeof n.chapter === 'number' ? `${chapterShort(n.chapter)}: ` : ''}${sceneName(n.title)}`;

/**
 * "Connect scenes…": From, Relation, To (with a filter) and an optional Rationale. Preview asks `onPreview(values)` (the container shows the dry-run diff, and Apply there writes);
 * it returns `{ error }` to keep this dialog open with a message. A self link and a link that already exists are caught here, in words, before anything is asked of the server.
 * A link may also start or end at a beat of a live structure (M5): both pickers have a "Beats" group of `beats`, each "<structure>: <beat>" (see beatOptions in requests.js).
 * @param {{ scenes: any[], beats?: { id: string, label: string }[], links?: any[], branches?: string[], initialBranch?: string | null, initialFrom?: string | null, initialTo?: string | null, onPreview: (v: { from: string, to: string, relation: string, rationale: string, branch: string | null }) => Promise<{ error?: string } | void>,
 *   onOpenExisting?: (slug: string) => void, onClose: () => void }} props
 *   `scenes` are the live scenes in reading order (GET /flow nodes), `links` the live links (GET /links `links`). The optional Branch (what-if) field names a branch (empty = the main plan); `branches` are the existing names it suggests.
 *   A link is a duplicate only when from, to, relation and branch all match.
 */
export function ConnectDialog({ scenes, beats = [], links = [], branches = [], initialBranch = null, initialFrom = null, initialTo = null, onPreview, onOpenExisting, onClose }) {
  const [from, setFrom] = useState(initialFrom ?? '');
  const [to, setTo] = useState(initialTo ?? '');
  const [relation, setRelation] = useState('therefore');
  const [rationale, setRationale] = useState('');
  const [filter, setFilter] = useState('');
  const [branch, setBranch] = useState(initialBranch ?? '');
  const [problem, setProblem] = useState(/** @type {{ message: string, existing?: string } | null} */ (null));
  const [busy, setBusy] = useState(false);
  const targets = filterNodes(scenes, filter);
  const what = beats.length > 0 ? 'scene or beat' : 'scene';
  const needle = filter.trim().toLowerCase();
  const targetBeats = beats.filter((b) => b.id === to || needle === '' || b.label.toLowerCase().includes(needle));
  const targetOptions = to !== '' && !targets.some((n) => n.id === to) ? [...scenes.filter((n) => n.id === to), ...targets] : targets;

  async function submit(e) {
    e.preventDefault();
    if (from === '' || to === '') {
      setProblem({ message: 'Choose both scenes.' });
      return;
    }
    if (from === to) {
      setProblem({ message: "A scene can't lead to itself." });
      return;
    }
    const b = validateBranch(branch);
    if (b.error) {
      setProblem({ message: b.error });
      return;
    }
    const twin = links.find((l) => l.from === from && l.to === to && l.relation === relation && (l.branch ?? null) === b.value);
    if (twin) {
      setProblem({ message: 'These scenes already have that link.', existing: twin.slug });
      return;
    }
    setProblem(null);
    setBusy(true);
    const r = await onPreview({ from, to, relation, rationale, branch: b.value });
    setBusy(false);
    if (r?.error) setProblem({ message: r.error });
  }

  return (
    <Dialog label="Connect scenes" onClose={onClose}>
      <h2>Connect scenes</h2>
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="connect-from">From {what}</label>
          <select id="connect-from" value={from} onChange={(e) => setFrom(e.target.value)} required>
            <option value="">Choose a {what}</option>
            {scenes.map((n) => (
              <option key={n.id} value={n.id}>
                {sceneOption(n)}
              </option>
            ))}
            {beats.length > 0 && (
              <optgroup label="Beats">
                {beats.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="connect-relation">Relation</label>
          <select id="connect-relation" value={relation} onChange={(e) => setRelation(e.target.value)}>
            {RELATIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {`${relationLabel(r.value)} — ${r.description}`}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="connect-to-filter">Find the To {what}</label>
          <input id="connect-to-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" placeholder="Part of a title" />
        </div>
        <div className="form-row">
          <label htmlFor="connect-to">To {what}</label>
          <select id="connect-to" value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">Choose a {what}</option>
            {targetOptions.map((n) => (
              <option key={n.id} value={n.id}>
                {sceneOption(n)}
              </option>
            ))}
            {targetBeats.length > 0 && (
              <optgroup label="Beats">
                {targetBeats.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {filter.trim() !== '' && targets.length === 0 && targetBeats.length === 0 && <p className="muted form-hint">No scene has that in its title.</p>}
        </div>
        <div className="form-row">
          <label htmlFor="connect-rationale">Rationale (optional)</label>
          <textarea id="connect-rationale" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor="connect-branch">Branch (what-if)</label>
          <input id="connect-branch" type="text" value={branch} list="connect-branch-list" autoComplete="off" aria-describedby="connect-branch-hint" aria-invalid={validateBranch(branch).error !== null} onChange={(e) => setBranch(e.target.value)} />
          <datalist id="connect-branch-list">
            {branches.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <p id="connect-branch-hint" className="muted form-hint">{`Leave empty for the main plan. ${BRANCH_RULE}`}</p>
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem.message}{' '}
            {problem.existing && (
              <button type="button" className="btn btn-small" onClick={() => onOpenExisting?.(problem.existing)}>
                Open the existing link
              </button>
            )}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}
