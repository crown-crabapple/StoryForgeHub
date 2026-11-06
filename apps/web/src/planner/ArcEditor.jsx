import { useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { sceneHref } from '../planning/model.js';
import { sceneLabel } from './model.js';
import { ARC_FIELDS, ARC_TYPES, MILESTONE_FIELDS, fieldValue } from './requests.js';

/** One arc field: a labelled input. Enter (the form's submit) or leaving it saves a change; a refused save may be tried again. */
function ArcField({ id, label, saved, onSave }) {
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

/** The notes text of an arc, with an explicit Save button. */
function ArcNotes({ saved, onSave }) {
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
      <label htmlFor="arc-notes">Notes</label>
      <textarea id="arc-notes" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <div>
        <button type="submit" className="btn" disabled={!changed}>
          Save notes
        </button>
      </div>
    </form>
  );
}

let uid = 0;
const blank = (scene = '') => ({ uid: `m${(uid += 1)}`, scene, pressure: '', choice: '', belief_before: '', belief_after: '', cost: '' });
const fromArc = (arc) => (arc.milestones ?? []).map((m) => ({ ...blank(m.scene), ...Object.fromEntries(MILESTONE_FIELDS.map((f) => [f.key, m[f.key] ?? ''])) }));
const plain = (list) => JSON.stringify(list.map((m) => [m.scene, ...MILESTONE_FIELDS.map((f) => m[f.key])]));

/**
 * The ordered milestone list of an arc. Edits stay here until "Save milestones", which sends the whole list. Move up, Move down and Remove are plain buttons.
 * @param {{ bookId: string, arc: any, scenes: any[], defaultScene?: string | null, busy?: boolean, onSave?: (list: any[]) => void }} props
 */
function MilestonesEditor({ bookId, arc, scenes, defaultScene, busy, onSave }) {
  const [list, setList] = useState(() => fromArc(arc));
  const [saved] = useState(() => plain(fromArc(arc)));
  const dirty = plain(list) !== saved;
  const incomplete = list.some((m) => m.scene === '');
  const set = (i, patch) => setList((l) => l.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const move = (i, by) =>
    setList((l) => {
      const next = [...l];
      const [item] = next.splice(i, 1);
      next.splice(i + by, 0, item);
      return next;
    });
  const known = new Set(scenes.map((n) => n.id));
  return (
    <section className="arc-milestones" aria-labelledby="arc-milestones-h">
      <h3 id="arc-milestones-h">Milestones</h3>
      {list.length === 0 ? <p className="muted">No milestones yet. Add the scenes where this arc turns.</p> : null}
      <ol className="arc-milestone-list">
        {list.map((m, i) => (
          <li key={m.uid} className="arc-milestone">
            <h4>{`Milestone ${i + 1}`}</h4>
            <div className="arc-field">
              <label htmlFor={`ms-scene-${m.uid}`}>Scene</label>
              <select id={`ms-scene-${m.uid}`} value={m.scene} onChange={(e) => set(i, { scene: e.target.value })}>
                <option value="">Choose a scene</option>
                {m.scene !== '' && !known.has(m.scene) && <option value={m.scene}>Missing scene</option>}
                {scenes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {sceneLabel(n)}
                  </option>
                ))}
              </select>
            </div>
            {m.scene !== '' && known.has(m.scene) && (
              <p>
                <Link to={sceneHref(bookId, m.scene)}>{`Open scene (milestone ${i + 1})`}</Link>
              </p>
            )}
            {MILESTONE_FIELDS.map((f) => (
              <div className="arc-field" key={f.key}>
                <label htmlFor={`ms-${f.key}-${m.uid}`}>{f.label}</label>
                <input id={`ms-${f.key}-${m.uid}`} type="text" value={m[f.key]} autoComplete="off" onChange={(e) => set(i, { [f.key]: e.target.value })} />
              </div>
            ))}
            <div className="arc-milestone-actions">
              <button type="button" className="btn btn-small" disabled={i === 0} aria-label={`Move milestone ${i + 1} up`} onClick={() => move(i, -1)}>
                Move up
              </button>
              <button type="button" className="btn btn-small" disabled={i === list.length - 1} aria-label={`Move milestone ${i + 1} down`} onClick={() => move(i, 1)}>
                Move down
              </button>
              <button type="button" className="btn btn-small" aria-label={`Remove milestone ${i + 1}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="arc-milestone-bar">
        <button type="button" className="btn" onClick={() => setList((l) => [...l, blank(defaultScene && known.has(defaultScene) ? defaultScene : '')])}>
          Add milestone
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || incomplete || busy} onClick={() => onSave?.(list)}>
          Save milestones
        </button>
        <span className="arc-dirty" role="status">
          {dirty ? 'Unsaved changes' : ''}
        </span>
      </div>
      {incomplete && <p className="muted">Choose a scene for every milestone before saving.</p>}
    </section>
  );
}

/**
 * The editor of one character arc, shared by the Codex page and the Plan tab's Arcs view. The arc type and each of the seven fields save on their own (Undo in the
 * toast); the notes have a Save button; the milestones are saved together. Presentational: every write is a handler that returns when done.
 * @param {{ bookId: string, arc: any, scenes: any[], defaultScene?: string | null, state?: { message?: string | null, error?: string | null, busy?: boolean },
 *   handlers?: { onSaveType?: (value: string | null) => void, onSaveField?: (key: string, value: string | null) => Promise<boolean> | boolean | void, onSaveNotes?: (text: string) => void,
 *     onSaveMilestones?: (list: any[]) => void, onArchive?: () => void } }} props
 *   `arc` is an Arc of GET /arcs, `scenes` the scenes in reading order (GET /flow nodes), `defaultScene` the scene a new milestone starts on.
 */
export function ArcEditor({ bookId, arc, scenes, defaultScene = null, state = {}, handlers = {} }) {
  const type = ARC_TYPES.find((t) => t.value === arc.arc_type);
  const stamp = arc.sha256 ?? '';
  return (
    <div className="arc-editor">
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
      <div className="arc-field">
        <label htmlFor="arc-type">Arc type</label>
        <select id="arc-type" value={arc.arc_type ?? ''} onChange={(e) => handlers.onSaveType?.(e.target.value === '' ? null : e.target.value)}>
          <option value="">Not set</option>
          {ARC_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {`${t.label}: ${t.words}`}
            </option>
          ))}
        </select>
      </div>
      {type && <p className="muted arc-type-words">{`This character ${type.words}.`}</p>}
      <div className="arc-fields">
        {ARC_FIELDS.map((f) => {
          const saved = arc.fields?.[f.key] ?? '';
          return <ArcField key={`${f.key}:${stamp}:${saved}`} id={`arc-${f.key}`} label={f.label} saved={saved} onSave={(v) => handlers.onSaveField?.(f.key, v)} />;
        })}
      </div>
      <ArcNotes key={`notes:${stamp}`} saved={arc.body ?? ''} onSave={(t) => handlers.onSaveNotes?.(t)} />
      <MilestonesEditor key={`ms:${stamp}`} bookId={bookId} arc={arc} scenes={scenes} defaultScene={defaultScene} busy={state.busy} onSave={(l) => handlers.onSaveMilestones?.(l)} />
      <p>
        <button type="button" className="btn" onClick={() => handlers.onArchive?.()}>
          Archive arc
        </button>
      </p>
    </div>
  );
}
