import { useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { sceneHref } from '../planning/model.js';
import { Dialog } from '../shell/Dialog.jsx';
import { orderEntries, sceneLabel } from './model.js';
import { RELATIONSHIP_FIELDS, fieldValue } from './requests.js';

/** One relationship field: a labelled input. Enter (the form's submit) or leaving it saves a change; a refused save may be tried again. */
function RelationshipField({ id, label, saved, onSave }) {
  const [text, setText] = useState(saved);
  const sent = useRef(fieldValue(saved));
  const commit = async () => {
    const value = fieldValue(text);
    if (value === sent.current) return;
    sent.current = value;
    const ok = await onSave(value);
    if (ok === false) sent.current = fieldValue(saved);
  };
  return (
    <form
      className="arc-field"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" value={text} placeholder="Not set" autoComplete="off" onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </form>
  );
}

/** The notes text of a relationship, with an explicit Save button. */
function RelationshipNotes({ saved, onSave }) {
  const [text, setText] = useState(saved);
  const changed = text !== saved;
  return (
    <form
      className="arc-notes"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(text);
      }}
    >
      <label htmlFor="rel-notes">Notes</label>
      <textarea id="rel-notes" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <div>
        <button type="submit" className="btn" disabled={!changed}>
          Save notes
        </button>
      </div>
    </form>
  );
}

let uid = 0;
const blank = (scene = '') => ({ uid: `d${(uid += 1)}`, scene, change: '', a_view: '', b_view: '' });
const fromRelationship = (rel) => (rel.developments ?? []).map((d) => ({ ...blank(d.scene), change: d.change ?? '', a_view: d.a_view ?? '', b_view: d.b_view ?? '' }));
const plain = (list) => JSON.stringify(list.map((d) => [d.scene, d.change, d.a_view, d.b_view]));

/**
 * The ordered development list of a relationship. Edits stay here until "Save developments", which sends the whole list. Move up, Move down and Remove are plain buttons.
 * @param {{ bookId: string, relationship: any, scenes: any[], busy?: boolean, onSave?: (list: any[]) => void }} props
 */
function DevelopmentsEditor({ bookId, relationship, scenes, busy, onSave }) {
  const [list, setList] = useState(() => fromRelationship(relationship));
  const [saved] = useState(() => plain(fromRelationship(relationship)));
  const dirty = plain(list) !== saved;
  const incomplete = list.some((d) => d.scene === '' || d.change.trim() === '');
  const set = (i, patch) => setList((l) => l.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i, by) =>
    setList((l) => {
      const next = [...l];
      const [item] = next.splice(i, 1);
      next.splice(i + by, 0, item);
      return next;
    });
  const known = new Set(scenes.map((n) => n.id));
  const aName = relationship.a?.name ?? 'A';
  const bName = relationship.b?.name ?? 'B';
  return (
    <section className="arc-milestones" aria-labelledby="rel-developments-h">
      <h3 id="rel-developments-h">Developments</h3>
      {list.length === 0 ? <p className="muted">No developments yet. Add the scenes where this relationship changes.</p> : null}
      <ol className="arc-milestone-list">
        {list.map((d, i) => (
          <li key={d.uid} className="arc-milestone">
            <h4>{`Development ${i + 1}`}</h4>
            <div className="arc-field">
              <label htmlFor={`dev-scene-${d.uid}`}>Scene</label>
              <select id={`dev-scene-${d.uid}`} value={d.scene} onChange={(e) => set(i, { scene: e.target.value })}>
                <option value="">Choose a scene</option>
                {d.scene !== '' && !known.has(d.scene) && <option value={d.scene}>Missing scene</option>}
                {scenes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {sceneLabel(n)}
                  </option>
                ))}
              </select>
            </div>
            {d.scene !== '' && known.has(d.scene) && (
              <p>
                <Link to={sceneHref(bookId, d.scene)}>{`Open scene (development ${i + 1})`}</Link>
              </p>
            )}
            <div className="arc-field">
              <label htmlFor={`dev-change-${d.uid}`}>Change</label>
              <input id={`dev-change-${d.uid}`} type="text" value={d.change} autoComplete="off" onChange={(e) => set(i, { change: e.target.value })} />
            </div>
            <div className="arc-field">
              <label htmlFor={`dev-a-${d.uid}`}>{`How ${aName} sees ${bName}`}</label>
              <input id={`dev-a-${d.uid}`} type="text" value={d.a_view} autoComplete="off" onChange={(e) => set(i, { a_view: e.target.value })} />
            </div>
            <div className="arc-field">
              <label htmlFor={`dev-b-${d.uid}`}>{`How ${bName} sees ${aName}`}</label>
              <input id={`dev-b-${d.uid}`} type="text" value={d.b_view} autoComplete="off" onChange={(e) => set(i, { b_view: e.target.value })} />
            </div>
            <div className="arc-milestone-actions">
              <button type="button" className="btn btn-small" disabled={i === 0} aria-label={`Move development ${i + 1} up`} onClick={() => move(i, -1)}>
                Move up
              </button>
              <button type="button" className="btn btn-small" disabled={i === list.length - 1} aria-label={`Move development ${i + 1} down`} onClick={() => move(i, 1)}>
                Move down
              </button>
              <button type="button" className="btn btn-small" aria-label={`Remove development ${i + 1}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="arc-milestone-bar">
        <button type="button" className="btn" onClick={() => setList((l) => [...l, blank()])}>
          Add development
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || incomplete || busy} onClick={() => onSave?.(list)}>
          Save developments
        </button>
        <span className="arc-dirty" role="status">
          {dirty ? 'Unsaved changes' : ''}
        </span>
      </div>
      {incomplete && <p className="muted">Choose a scene and write the change for every development before saving.</p>}
    </section>
  );
}

/**
 * The editor of one relationship between two Codex entries: baseline and end state (each saves on its own, with Undo in the toast), notes with a Save button, and the developments
 * (saved together). Presentational: every write is a handler that returns when done.
 * @param {{ bookId: string, relationship: any, scenes: any[], state?: { message?: string | null, error?: string | null, busy?: boolean },
 *   handlers?: { onSaveField?: (key: string, value: string | null) => Promise<boolean> | boolean | void, onSaveNotes?: (text: string) => void, onSaveDevelopments?: (list: any[]) => void, onArchive?: () => void } }} props
 *   `relationship` is a relationship of GET /relationships, `scenes` the scenes in reading order (GET /flow nodes).
 */
export function RelationshipEditor({ bookId, relationship, scenes, state = {}, handlers = {} }) {
  const stamp = relationship.sha256 ?? '';
  return (
    <div className="arc-editor ln-relationship-editor">
      {state.message && (
        <p className="muted" role="status">
          {state.message}
        </p>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="arc-fields">
        {RELATIONSHIP_FIELDS.map((f) => {
          const saved = relationship[f.key] ?? '';
          return <RelationshipField key={`${f.key}:${stamp}:${saved}`} id={`rel-${f.key}`} label={f.label} saved={saved} onSave={(v) => handlers.onSaveField?.(f.key, v)} />;
        })}
      </div>
      <RelationshipNotes key={`notes:${stamp}`} saved={relationship.body ?? ''} onSave={(t) => handlers.onSaveNotes?.(t)} />
      <DevelopmentsEditor key={`dev:${stamp}`} bookId={bookId} relationship={relationship} scenes={scenes} busy={state.busy} onSave={(l) => handlers.onSaveDevelopments?.(l)} />
      <p>
        <button type="button" className="btn" onClick={() => handlers.onArchive?.()}>
          Archive relationship
        </button>
      </p>
    </div>
  );
}

/**
 * "New relationship…": pick entry A and entry B of the Codex (characters first, then the other types), then create. The same entry twice is refused here. `onCreate(a, b)` resolves to
 * `{ ok: true }` (the container closes the dialog) or `{ ok: false, message, existing? }`; a duplicate offers "Open existing".
 * @param {{ entries: { id: string, title?: string | null, slug?: string, type?: string }[], onCreate: (a: string, b: string) => Promise<any>, onOpenExisting?: (slug: string) => void, onClose: () => void }} props
 */
export function NewRelationshipDialog({ entries, onCreate, onOpenExisting, onClose }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {{ message: string, existing?: string | null } | null} */ (null));
  const ordered = orderEntries(entries);
  const option = (e) => `${e.title ?? e.slug}${e.type && e.type !== 'character' ? ` (${e.type})` : ''}`;
  async function submit(ev) {
    ev.preventDefault();
    if (a === '' || b === '') {
      setProblem({ message: 'Choose two entries.' });
      return;
    }
    if (a === b) {
      setProblem({ message: 'Choose two different entries.' });
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await onCreate(a, b);
    setBusy(false);
    if (r && r.ok === false) setProblem({ message: r.message, existing: r.existing });
  }
  const picker = (id, label, value, set, other) => (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => set(e.target.value)} required>
        <option value="">Choose an entry</option>
        {ordered.map((e) => (
          <option key={e.id} value={e.id} disabled={e.id === other}>
            {option(e)}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <Dialog label="New relationship" onClose={onClose}>
      <h2>New relationship</h2>
      <form onSubmit={submit}>
        {picker('new-rel-a', 'First entry (A)', a, setA, b)}
        {picker('new-rel-b', 'Second entry (B)', b, setB, a)}
        {entries.length < 2 && <p className="muted form-hint">A relationship needs two Codex entries. Add them in the Codex first.</p>}
        {problem && (
          <p role="alert" className="error">
            {problem.message}{' '}
            {problem.existing && (
              <button type="button" className="btn btn-small" onClick={() => onOpenExisting?.(problem.existing)}>
                Open existing
              </button>
            )}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Start relationship
          </button>
        </div>
      </form>
    </Dialog>
  );
}
