import { useState } from 'react';
import { filterNodes, sceneLabel } from './model.js';
import { BEAT_STATES } from './requests.js';

let uid = 0;
const blank = () => ({ uid: `b${(uid += 1)}`, id: '', name: '', purpose: '', question: '', position: '', state: 'open', scenes: [], find: '' });
const fromStructure = (structure) =>
  (structure.beats ?? []).map((b) => ({
    ...blank(),
    id: b.id ?? '',
    name: b.name ?? '',
    purpose: b.purpose ?? '',
    question: b.question ?? '',
    position: b.position ?? '',
    state: BEAT_STATES.some((s) => s.value === b.state) ? b.state : 'open',
    scenes: (b.scenes ?? []).map((s) => (typeof s === 'string' ? s : s.id)),
  }));
const plain = (list) => JSON.stringify(list.map((b) => [b.id, b.name, b.purpose, b.question, b.position, b.state, b.scenes]));

const TEXT_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'purpose', label: 'Purpose' },
  { key: 'question', label: 'Question' },
  { key: 'position', label: 'Position (such as about 25%)' },
];

/**
 * The ordered beat sheet of one structure. Edits stay here until "Save beats", which sends the whole list. Move up, Move down and Remove are plain buttons; the state
 * of a beat is a select with words (Open, Done, Omitted); scenes are assigned with a search box and a select, and removed with the button of their chip.
 * @param {{ structure: any, scenes: any[], busy?: boolean, onSave?: (list: any[]) => void }} props
 *   `structure` is a Structure of GET /structures, `scenes` the scenes in reading order (GET /flow nodes).
 */
export function BeatSheetEditor({ structure, scenes, busy = false, onSave }) {
  const [list, setList] = useState(() => fromStructure(structure));
  const [saved] = useState(() => plain(fromStructure(structure)));
  const dirty = plain(list) !== saved;
  const incomplete = list.some((b) => b.name.trim() === '');
  const set = (i, patch) => setList((l) => l.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i, by) =>
    setList((l) => {
      const next = [...l];
      const [item] = next.splice(i, 1);
      next.splice(i + by, 0, item);
      return next;
    });
  const nodeById = new Map(scenes.map((n) => [n.id, n]));
  return (
    <section className="st-beats" aria-labelledby="st-beats-h">
      <h3 id="st-beats-h">Beats</h3>
      {list.length === 0 ? <p className="muted">No beats yet. Add the moments this structure asks for.</p> : null}
      <ol className="st-beat-list">
        {list.map((b, i) => {
          const options = filterNodes(scenes, b.find).filter((n) => !b.scenes.includes(n.id));
          return (
            <li key={b.uid} className="st-beat">
              <h4>{`Beat ${i + 1}${b.name.trim() ? `: ${b.name.trim()}` : ''}`}</h4>
              {TEXT_FIELDS.map((f) => (
                <div className="st-field" key={f.key}>
                  <label htmlFor={`beat-${f.key}-${b.uid}`}>{`${f.label}, beat ${i + 1}`}</label>
                  <input id={`beat-${f.key}-${b.uid}`} type="text" value={b[f.key]} required={f.required} autoComplete="off" onChange={(e) => set(i, { [f.key]: e.target.value })} />
                </div>
              ))}
              <div className="st-field">
                <label htmlFor={`beat-state-${b.uid}`}>{`State of beat ${i + 1}`}</label>
                <select id={`beat-state-${b.uid}`} value={b.state} onChange={(e) => set(i, { state: e.target.value })}>
                  {BEAT_STATES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="st-scenes">
                <p className="st-scenes-label" id={`beat-scenes-${b.uid}`}>{`Scenes in beat ${i + 1}`}</p>
                {b.scenes.length === 0 ? (
                  <p className="muted">No scene assigned.</p>
                ) : (
                  <ul className="st-chips" aria-labelledby={`beat-scenes-${b.uid}`}>
                    {b.scenes.map((id) => {
                      const label = nodeById.has(id) ? sceneLabel(nodeById.get(id)) : 'Missing scene';
                      return (
                        <li key={id} className="st-chip">
                          <span>{label}</span>
                          <button type="button" className="btn btn-small" aria-label={`Remove scene ${label} from beat ${i + 1}`} onClick={() => set(i, { scenes: b.scenes.filter((s) => s !== id) })}>
                            Remove
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="st-field">
                  <label htmlFor={`beat-find-${b.uid}`}>{`Search scenes to add to beat ${i + 1}`}</label>
                  <input id={`beat-find-${b.uid}`} type="search" value={b.find} autoComplete="off" onChange={(e) => set(i, { find: e.target.value })} />
                </div>
                <div className="st-field">
                  <label htmlFor={`beat-add-${b.uid}`}>{`Add scene to beat ${i + 1}`}</label>
                  <select id={`beat-add-${b.uid}`} value="" onChange={(e) => e.target.value !== '' && set(i, { scenes: [...b.scenes, e.target.value], find: '' })}>
                    <option value="">{options.length === 0 ? 'No scene to add' : 'Add scene'}</option>
                    {options.map((n) => (
                      <option key={n.id} value={n.id}>
                        {sceneLabel(n)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="st-beat-actions">
                <button type="button" className="btn btn-small" disabled={i === 0} aria-label={`Move beat ${i + 1} up`} onClick={() => move(i, -1)}>
                  Move up
                </button>
                <button type="button" className="btn btn-small" disabled={i === list.length - 1} aria-label={`Move beat ${i + 1} down`} onClick={() => move(i, 1)}>
                  Move down
                </button>
                <button type="button" className="btn btn-small" aria-label={`Remove beat ${i + 1}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
                  Remove beat
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="st-bar">
        <button type="button" className="btn" onClick={() => setList((l) => [...l, blank()])}>
          Add beat
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || incomplete || busy} onClick={() => onSave?.(list)}>
          Save beats
        </button>
        <span className="st-dirty" role="status">
          {dirty ? 'Unsaved changes' : ''}
        </span>
      </div>
      {incomplete && <p className="muted">Give every beat a name before saving.</p>}
    </section>
  );
}
