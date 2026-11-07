import { useState } from 'react';
import { Link } from '../router.jsx';
import { sceneHref } from '../planning/model.js';
import { CLUE_KINDS, READER, blankKnower, clueGrid, kindLabel, knowerRows, plainKnowers, plantedText, revealedText, validateKnowers } from './clues.js';
import { sceneLabel } from './model.js';
import { planHref } from './requests.js';
import { useClueWrites } from './useClueWrites.js';
import './clue.css';

/** The clue-by-scene grid: one row per clue, one column per scene in reading order, P / R / K in the cells. A real table with row and column headers; it scrolls sideways inside its own region. */
export function ClueGrid({ clues, scenes }) {
  const [onlyMarked, setOnlyMarked] = useState(false);
  const grid = clueGrid({ clues, scenes, onlyMarked });
  return (
    <section aria-labelledby="cl-grid-h" className="plan-block">
      <h2 id="cl-grid-h">Clues by scene</h2>
      <p className="muted">P: planted (the reader can notice it). R: revealed. K: someone learns it here (hover or focus a mark to see who).</p>
      <label className="cl-toggle">
        <input type="checkbox" checked={onlyMarked} onChange={(e) => setOnlyMarked(e.target.checked)} /> Show only scenes with marks
      </label>
      {clues.length === 0 || scenes.length === 0 ? (
        <p className="muted">{clues.length === 0 ? 'No clues to show yet.' : 'This book has no scenes yet.'}</p>
      ) : grid.columns.length === 0 ? (
        <p className="muted">No scene has a mark yet.</p>
      ) : (
        <div className="cl-grid-scroll" role="region" aria-label="Clues by scene (scrolls sideways)" tabIndex={0}>
          <table className="cl-grid">
            <caption className="cl-sr">{`Clues (rows) by scenes (columns)${onlyMarked && grid.hidden > 0 ? `; ${grid.hidden} scenes without marks are hidden` : ''}`}</caption>
            <thead>
              <tr>
                <th scope="col">Clue</th>
                {grid.columns.map((c) => (
                  <th key={c.id} scope="col" title={c.title}>
                    <span aria-hidden="true">{c.short}</span>
                    <span className="cl-sr">{c.title}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((r) => (
                <tr key={r.slug}>
                  <th scope="row">{r.fact}</th>
                  {r.cells.map((cell) => (
                    <td key={cell.scene} title={cell.tip || undefined} data-marked={cell.marks !== '' ? 'true' : undefined}>
                      <span aria-hidden="true" className="cl-marks">
                        {cell.marks}
                      </span>
                      <span className="cl-sr">{cell.label}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The planted scenes of a clue as chips with Remove, and a select that adds one more. The list stays in reading order. */
function PlantedPicker({ scenes, value, onChange }) {
  const order = new Map(scenes.map((n, i) => [n.id, i]));
  const sorted = (ids) => [...ids].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  const byId = new Map(scenes.map((n) => [n.id, n]));
  return (
    <div className="cl-field">
      <label htmlFor="cl-planted-add">Planted in scenes</label>
      <ul className="cl-chips" aria-label="Planted scenes">
        {value.length === 0 && <li className="muted">None yet.</li>}
        {value.map((id) => {
          const name = byId.has(id) ? sceneLabel(byId.get(id)) : 'Missing scene';
          return (
            <li key={id} className="cl-chip">
              <span>{name}</span>
              <button type="button" className="btn btn-small" aria-label={`Remove ${name}`} onClick={() => onChange(value.filter((v) => v !== id))}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <select id="cl-planted-add" value="" onChange={(e) => e.target.value !== '' && onChange(sorted([...value, e.target.value]))}>
        <option value="">Add a scene…</option>
        {scenes
          .filter((n) => !value.includes(n.id))
          .map((n) => (
            <option key={n.id} value={n.id}>
              {sceneLabel(n)}
            </option>
          ))}
      </select>
    </div>
  );
}

/** The fields and notes of the open clue. Edits stay here until Save. */
function ClueFields({ item, scenes, writes, state }) {
  const [fact, setFact] = useState(item.fact ?? '');
  const [kind, setKind] = useState(item.kind ?? 'clue');
  const [planted, setPlanted] = useState((item.planted ?? []).map((p) => p.id));
  const [revealed, setRevealed] = useState(item.revealed?.id ?? '');
  const [herring, setHerring] = useState(item.red_herring === true);
  const [body, setBody] = useState(item.body ?? '');
  const was = (item.planted ?? []).map((p) => p.id);
  const patch = {};
  if (fact.trim() !== (item.fact ?? '')) patch.fact = fact;
  if (kind !== (item.kind ?? 'clue')) patch.kind = kind;
  if (JSON.stringify(planted) !== JSON.stringify(was)) patch.planted = planted;
  if (revealed !== (item.revealed?.id ?? '')) patch.revealed = revealed === '' ? null : revealed;
  if (herring !== (item.red_herring === true)) patch.red_herring = herring;
  if (body !== (item.body ?? '')) patch.body = body;
  const changed = Object.keys(patch).length > 0;
  const factBad = fact.trim() === '';
  const known = new Set(scenes.map((n) => n.id));
  return (
    <form
      className="cl-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !factBad) writes.save(item, patch);
      }}
    >
      {state.error && (
        <p className="error" role="alert">
          {state.error}{' '}
          {state.conflict && (
            <button type="button" className="btn btn-small" onClick={writes.reload}>
              Reload
            </button>
          )}
        </p>
      )}
      <div className="cl-field">
        <label htmlFor="cl-fact">Fact (one line)</label>
        <input id="cl-fact" type="text" value={fact} autoComplete="off" aria-invalid={factBad} onChange={(e) => setFact(e.target.value)} />
        {factBad && <span className="error">The fact can't be empty.</span>}
      </div>
      <div className="cl-field">
        <label htmlFor="cl-kind">Kind</label>
        <select id="cl-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {CLUE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {`${k.label}: ${k.words}`}
            </option>
          ))}
        </select>
      </div>
      <PlantedPicker scenes={scenes} value={planted} onChange={setPlanted} />
      <div className="cl-field">
        <label htmlFor="cl-revealed">Revealed in</label>
        <select id="cl-revealed" value={revealed} onChange={(e) => setRevealed(e.target.value)}>
          <option value="">None</option>
          {revealed !== '' && !known.has(revealed) && <option value={revealed}>Missing scene</option>}
          {scenes.map((n) => (
            <option key={n.id} value={n.id}>
              {sceneLabel(n)}
            </option>
          ))}
        </select>
      </div>
      <label className="cl-toggle">
        <input type="checkbox" checked={herring} onChange={(e) => setHerring(e.target.checked)} /> Red herring (deliberate misdirection)
      </label>
      <div className="cl-field">
        <label htmlFor="cl-body">Notes</label>
        <textarea id="cl-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="cl-bar">
        <button type="submit" className="btn btn-primary" disabled={!changed || factBad || state.busy}>
          Save
        </button>
        {changed && (
          <span className="cl-dirty" role="status">
            Unsaved changes
          </span>
        )}
      </div>
    </form>
  );
}

/** The knowers of the open clue: who learns it in which scene. Edits stay here until "Save knowers", which sends the whole list. */
function KnowersEditor({ item, scenes, characters, writes, state }) {
  const [rows, setRows] = useState(() => knowerRows(item));
  const [saved] = useState(() => plainKnowers(knowerRows(item)));
  const dirty = plainKnowers(rows) !== saved;
  const check = validateKnowers(rows);
  const set = (i, patch) => setRows((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const known = new Set(scenes.map((n) => n.id));
  const people = [...characters];
  for (const k of item.knowers ?? []) if (!k.who?.reader && k.who?.id && !people.some((c) => c.id === k.who.id)) people.push({ id: k.who.id, title: k.who.name });
  return (
    <section aria-labelledby="cl-knowers-h" className="cl-knowers">
      <h3 id="cl-knowers-h">Knowers</h3>
      <p className="muted">Who learns this fact, and where. Add the reader in a scene without adding the character to show something only the reader sees.</p>
      {rows.length === 0 ? (
        <p className="muted">Nobody learns it yet.</p>
      ) : (
        <div className="cl-grid-scroll">
          <table className="cl-knowers-table">
            <thead>
              <tr>
                <th scope="col">Who</th>
                <th scope="col">Scene</th>
                <th scope="col">How</th>
                <th scope="col">Reliable</th>
                <th scope="col">Row</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid}>
                  <td>
                    <select aria-label={`Who, row ${i + 1}`} value={r.who} onChange={(e) => set(i, { who: e.target.value })}>
                      <option value="">Choose…</option>
                      <option value={READER}>The reader</option>
                      {people.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title ?? c.slug}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`Scene, row ${i + 1}`} value={r.scene} onChange={(e) => set(i, { scene: e.target.value })}>
                      <option value="">Choose…</option>
                      {r.scene !== '' && !known.has(r.scene) && <option value={r.scene}>Missing scene</option>}
                      {scenes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {sceneLabel(n)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="text" aria-label={`How, row ${i + 1}`} value={r.how} autoComplete="off" onChange={(e) => set(i, { how: e.target.value })} />
                  </td>
                  <td>
                    <label className="cl-toggle">
                      <input type="checkbox" checked={r.reliable} onChange={(e) => set(i, { reliable: e.target.checked })} aria-label={`Reliable, row ${i + 1}`} />
                      {r.reliable ? 'Reliable' : 'Believes something false'}
                    </label>
                  </td>
                  <td>
                    <button type="button" className="btn btn-small" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((l) => l.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!check.ok && (
        <ul className="error" role="alert">
          {check.errors.map((e) => (
            <li key={e.index}>{e.message}</li>
          ))}
        </ul>
      )}
      <div className="cl-bar">
        <button type="button" className="btn" onClick={() => setRows((l) => [...l, blankKnower()])}>
          Add knower
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || !check.ok || state.busy} onClick={() => writes.saveKnowers(item, rows)}>
          Save knowers
        </button>
        {dirty && (
          <span className="cl-dirty" role="status">
            Unsaved changes
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * The Clues view of the Plan tab: the list with a New clue form, the editor of the selected clue (fields, notes, knowers), the archived clues, and the clue-by-scene grid.
 * @param {{ bookId: string, list: { clues: any[], archived: any[] } | null, detail: any | null, detailLoading?: boolean, selected: string | null, scenes: any[], characters: { id: string, slug?: string, title?: string }[],
 *   structure: any, refresh: () => void, onSelect: (slug: string | null) => void }} props `scenes` are the live scenes in reading order (GET /flow nodes without beats).
 */
export function ClueView({ bookId, list, detail, detailLoading = false, selected, scenes, characters, structure, refresh, onSelect }) {
  const writes = useClueWrites({ bookId, structure, refresh });
  const [fact, setFact] = useState('');
  const [kind, setKind] = useState('clue');
  const [createState, setCreateState] = useState({ busy: false, error: null });
  const item = detail && detail.slug === selected ? detail : null;
  const state = writes.state.slug === selected ? writes.state : { busy: false, error: null, conflict: false, message: null };
  const clues = list?.clues ?? [];
  const archived = list?.archived ?? [];

  async function create(e) {
    e.preventDefault();
    if (fact.trim() === '') {
      setCreateState({ busy: false, error: 'Write the fact first.' });
      return;
    }
    setCreateState({ busy: true, error: null });
    const r = await writes.create({ fact, kind });
    if (r.ok) {
      setCreateState({ busy: false, error: null });
      setFact('');
      if (r.slug) onSelect(r.slug);
    } else setCreateState({ busy: false, error: r.message });
  }

  return (
    <div className="cl-view">
      <section aria-labelledby="cl-list-h" className="plan-block">
        <h2 id="cl-list-h">Clues</h2>
        {list === null ? (
          <p className="muted">Loading…</p>
        ) : clues.length === 0 ? (
          <p className="muted">No clues yet. Start one below.</p>
        ) : (
          <ul className="cl-list" aria-label="Clues">
            {clues.map((c) => (
              <li key={c.slug} className="cl-item">
                <Link to={planHref(bookId, { view: 'clues', clue: c.slug })} aria-current={c.slug === selected ? 'page' : undefined}>
                  <strong>{c.fact}</strong>
                </Link>{' '}
                <span className="muted">{kindLabel(c.kind)}</span> <span>{plantedText(c)}</span> <span>{revealedText(c)}</span>
                {c.red_herring && <span className="badge cl-badge">Red herring</span>}
                {(c.problems ?? []).length > 0 && <span className="badge badge-warn cl-badge">{`${c.problems.length} ${c.problems.length === 1 ? 'problem' : 'problems'}`}</span>}
              </li>
            ))}
          </ul>
        )}
        <form className="cl-new" onSubmit={create} aria-label="New clue">
          <h3>New clue</h3>
          <div className="cl-field">
            <label htmlFor="cl-new-fact">Fact (one line)</label>
            <input id="cl-new-fact" type="text" value={fact} autoComplete="off" onChange={(e) => setFact(e.target.value)} />
          </div>
          <div className="cl-field">
            <label htmlFor="cl-new-kind">Kind</label>
            <select id="cl-new-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {CLUE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {`${k.label}: ${k.words}`}
                </option>
              ))}
            </select>
          </div>
          {createState.error && (
            <p className="error" role="alert">
              {createState.error}
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={createState.busy}>
            New clue
          </button>
        </form>
      </section>

      {selected && (
        <section aria-labelledby="cl-edit-h" className="plan-block">
          <h2 id="cl-edit-h">{item ? item.fact : 'Clue'}</h2>
          {!item ? (
            detailLoading ? (
              <p className="muted">Loading…</p>
            ) : (
              <p className="muted">That clue is not here. It may be archived or removed.</p>
            )
          ) : (
            <div className="cl-editor" key={`${item.slug}:${item.sha256}`}>
              {(item.problems ?? []).length > 0 && (
                <ul className="cl-problems" aria-label="Problems found in this clue">
                  {item.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {item.revealed && (
                <p>
                  <Link to={sceneHref(bookId, item.revealed.id)}>Open the reveal scene</Link>
                </p>
              )}
              <ClueFields item={item} scenes={scenes} writes={writes} state={state} />
              <KnowersEditor item={item} scenes={scenes} characters={characters} writes={writes} state={state} />
              <p>
                <button type="button" className="btn" disabled={state.busy} onClick={() => writes.archive(item, { onArchived: () => onSelect(null) })}>
                  Archive clue
                </button>
              </p>
            </div>
          )}
        </section>
      )}

      {archived.length > 0 && (
        <section aria-labelledby="cl-archived-h" className="plan-block">
          <h2 id="cl-archived-h">Archived clues</h2>
          <ul className="cl-list">
            {archived.map((c) => (
              <li key={c.slug} className="cl-item">
                <span>{c.fact}</span>{' '}
                <button type="button" className="btn btn-small" aria-label={`Restore ${c.fact}`} onClick={() => writes.restore(c, { onRestored: (slug) => onSelect(slug) })}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ClueGrid clues={clues} scenes={scenes} />
    </div>
  );
}
