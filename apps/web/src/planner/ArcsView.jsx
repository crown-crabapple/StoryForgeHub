import { useState } from 'react';
import { Link } from '../router.jsx';
import { sceneHref } from '../planning/model.js';
import { Dialog } from '../shell/Dialog.jsx';
import { LANE_COL_W, LANE_HEAD, LANE_LABEL_W, LANE_MARK, LANE_PAD, LANE_ROW_H, arcName, layoutLanes, milestoneSummary, sceneName } from './model.js';
import { ARC_TYPES, MILESTONE_FIELDS } from './requests.js';

/** "<choice> / <pressure>" for the list rows: whichever of the two are written. */
const rowSummary = (m) => [m.choice, m.pressure].filter(Boolean).join(' / ');

/**
 * The lanes: one row per arc, one narrow column per scene in reading order, a diamond marker with the milestone's number at each milestone's scene. A marker is a button whose
 * name says who, what and where; the same milestones are in the List view.
 * @param {{ arcs: any[], nodes: any[], selected?: { slug: string, index: number } | null, onSelect?: (slug: string, index: number) => void }} props
 */
export function ArcLanes({ arcs, nodes, selected = null, onSelect }) {
  const lanes = layoutLanes(arcs, nodes);
  return (
    <div className="arc-lanes-scroll">
      <div className="arc-lanes" role="group" aria-label="Arc lanes. The same milestones are in the List view." style={{ width: lanes.width, height: lanes.height }}>
        {lanes.chapters.map((c) => (
          <span key={`${c.key}:${c.x}`} className="arc-lane-chapter" style={{ left: c.x, width: c.width, top: LANE_PAD }}>
            {c.label}
          </span>
        ))}
        {lanes.columns.map((c, i) => (
          <span key={c.id} className="arc-lane-col" style={{ left: c.x, width: LANE_COL_W, top: LANE_HEAD - 16, height: lanes.height - LANE_HEAD + 16 }} title={c.title} aria-hidden="true">
            {i + 1}
          </span>
        ))}
        {lanes.rows.map((r) => (
          <div key={r.slug} className="arc-lane" style={{ top: r.y, height: LANE_ROW_H, width: lanes.width }}>
            <span className="arc-lane-name" style={{ width: LANE_LABEL_W }}>
              {r.name}
            </span>
            <span className="arc-lane-line" style={{ left: LANE_LABEL_W, top: LANE_ROW_H / 2 }} aria-hidden="true" />
          </div>
        ))}
        {lanes.rows.flatMap((r) =>
          r.markers.map((m) => (
            <button
              key={m.key}
              type="button"
              className="arc-marker"
              aria-label={m.name}
              aria-pressed={selected?.slug === m.slug && selected?.index === m.index}
              style={{ left: m.x, top: m.y, width: LANE_MARK, height: LANE_MARK }}
              onClick={() => onSelect?.(m.slug, m.index)}
            >
              <span aria-hidden="true">{m.text}</span>
            </button>
          )),
        )}
      </div>
      {lanes.unplaced > 0 && <p className="muted">{`${lanes.unplaced} ${lanes.unplaced === 1 ? 'milestone points' : 'milestones point'} to a scene that is not in the book; the List shows ${lanes.unplaced === 1 ? 'it' : 'them'}.`}</p>}
    </div>
  );
}

/** The list: per arc a heading and its milestones in order, as rows "<scene> — <choice / pressure>" with belief before → after. */
export function ArcList({ arcs, nodeById, selected, selectedMilestone, onSelectArc, onSelectMilestone }) {
  return (
    <div className="arc-list">
      {arcs.map((arc) => (
        <section key={arc.id} className="plan-block arc-list-arc" aria-labelledby={`arc-h-${arc.slug}`} aria-current={arc.slug === selected ? 'true' : undefined}>
          <h2 id={`arc-h-${arc.slug}`}>
            {arcName(arc)}
            {arc.arc_type && <span className="muted arc-list-type">{` · ${ARC_TYPES.find((t) => t.value === arc.arc_type)?.label ?? arc.arc_type}`}</span>}
          </h2>
          <p>
            <button type="button" className="btn btn-small" aria-label={`Edit the arc of ${arcName(arc)}`} onClick={() => onSelectArc?.(arc.slug)}>
              Edit arc
            </button>
          </p>
          {(arc.milestones ?? []).length === 0 ? (
            <p className="muted">No milestones yet.</p>
          ) : (
            <ol className="arc-rows">
              {arc.milestones.map((m) => {
                const title = sceneName(nodeById.get(m.scene)?.title ?? m.scene_title);
                const gone = !nodeById.has(m.scene);
                const summary = rowSummary(m);
                const belief = m.belief_before || m.belief_after ? `${m.belief_before || '…'} → ${m.belief_after || '…'}` : '';
                return (
                  <li key={m.index} className="arc-row" aria-current={selectedMilestone?.slug === arc.slug && selectedMilestone?.index === m.index ? 'true' : undefined}>
                    <button type="button" className="flow-scene-button" aria-label={`Milestone ${m.index + 1} of ${arcName(arc)}: ${title}`} onClick={() => onSelectMilestone?.(arc.slug, m.index)}>
                      {title}
                    </button>
                    {gone && <span className="tag"> missing scene</span>}
                    {summary ? ` — ${summary}` : ''}
                    {belief && <span className="muted arc-row-belief">{belief}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

/** The details of one milestone, with a link to its scene. */
function MilestoneDetails({ bookId, arc, index, nodeById }) {
  const m = (arc.milestones ?? []).find((x) => x.index === index);
  if (!m) return null;
  const node = nodeById.get(m.scene);
  return (
    <section className="arc-milestone-details" aria-labelledby="arc-ms-h">
      <h3 id="arc-ms-h">{`Milestone ${m.index + 1}: ${sceneName(node?.title ?? m.scene_title)}`}</h3>
      <dl className="flow-ends">
        {MILESTONE_FIELDS.filter((f) => m[f.key]).map((f) => (
          <div key={f.key} className="arc-detail-row">
            <dt>{f.label}</dt>
            <dd>{m[f.key]}</dd>
          </div>
        ))}
      </dl>
      {!milestoneSummary(m) && MILESTONE_FIELDS.every((f) => !m[f.key]) && <p className="muted">Nothing written for this milestone yet.</p>}
      {node ? (
        <p>
          <Link to={sceneHref(bookId, m.scene)}>Open scene</Link>
        </p>
      ) : (
        <p className="muted">That scene is not in the book any more.</p>
      )}
    </section>
  );
}

/**
 * "New arc…": pick a character entry of the book (one that already has an arc is listed but cannot be chosen), then create. `onCreate(entryId)` resolves to
 * `{ ok: true }` (the container closes the dialog) or `{ ok: false, message, existing? }`.
 * @param {{ characters: { id: string, title?: string | null, slug?: string }[], hasArc: Set<string>, onCreate: (id: string) => Promise<any>, onOpenExisting?: (slug: string) => void, onClose: () => void }} props
 */
export function NewArcDialog({ characters, hasArc, onCreate, onOpenExisting, onClose }) {
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {{ message: string, existing?: string | null } | null} */ (null));
  async function submit(e) {
    e.preventDefault();
    if (id === '') {
      setProblem({ message: 'Choose a character.' });
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await onCreate(id);
    setBusy(false);
    if (r && r.ok === false) setProblem({ message: r.message, existing: r.existing });
  }
  return (
    <Dialog label="New arc" onClose={onClose}>
      <h2>New arc</h2>
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="new-arc-character">Character</label>
          <select id="new-arc-character" value={id} onChange={(e) => setId(e.target.value)} required>
            <option value="">Choose a character</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id} disabled={hasArc.has(c.id)}>
                {`${c.title ?? c.slug}${hasArc.has(c.id) ? ' (has an arc)' : ''}`}
              </option>
            ))}
          </select>
          {characters.length === 0 && <p className="muted form-hint">This book has no character entries yet. Add one in the Codex first.</p>}
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem.message}{' '}
            {problem.existing && (
              <button type="button" className="btn btn-small" onClick={() => onOpenExisting?.(problem.existing)}>
                Open the existing arc
              </button>
            )}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Start arc
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The Arcs view of the Plan tab: lanes (wide screens) or a list of every arc's milestones, with the side panel for the selected arc (`panel`, the ArcEditor) or milestone.
 * Presentational.
 * @param {{ bookId: string, arcs: { arcs: any[], archived?: any[] } | null, flow: { nodes: any[] } | null, url: ReturnType<typeof import('./model.js').parsePlanSearch>, wide?: boolean,
 *   selectedMilestone?: { slug: string, index: number } | null, panel?: import('react').ReactNode, canCreate?: boolean,
 *   handlers?: { onMode?: (mode: 'list' | 'graph') => void, onNewArc?: () => void, onSelectArc?: (slug: string) => void, onSelectMilestone?: (slug: string, index: number) => void } }} props
 *   `wide` is true from 768 px up: below that only the list is shown. Without `url.mode` the lanes are the default on wide screens (`mode=graph`).
 */
export function ArcsView({ bookId, arcs, flow, url, wide = true, selectedMilestone = null, panel = null, canCreate = true, handlers = {} }) {
  const nodes = flow?.nodes ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const live = arcs?.arcs ?? [];
  const mode = wide ? (url.mode ?? 'graph') : 'list';
  const arc = url.arc ? live.find((a) => a.slug === url.arc) : null;
  const milestone = arc && selectedMilestone?.slug === arc.slug ? selectedMilestone : null;
  return (
    <div className="plan-arcs">
      <div className="flow-toolbar">
        <div className="flow-mode" role="group" aria-label="Show arcs as">
          <button type="button" className="btn" aria-pressed={mode === 'list'} onClick={() => handlers.onMode?.('list')}>
            List
          </button>
          <button type="button" className="btn" aria-pressed={mode === 'graph'} disabled={!wide} onClick={() => handlers.onMode?.('graph')}>
            Lanes
          </button>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => handlers.onNewArc?.()} disabled={!canCreate}>
          New arc…
        </button>
      </div>
      {!wide && <p className="muted flow-note">The lanes need a screen at least 768 px wide. The list has every milestone.</p>}
      <div className="flow-body">
        <div className="flow-main">
          {arcs === null || flow === null ? (
            <p className="muted">Loading…</p>
          ) : live.length === 0 ? (
            <p>No arcs yet. Start one from a character&apos;s Codex page or with New arc.</p>
          ) : mode === 'graph' ? (
            <ArcLanes arcs={live} nodes={nodes} selected={milestone} onSelect={handlers.onSelectMilestone} />
          ) : (
            <ArcList arcs={live} nodeById={nodeById} selected={url.arc} selectedMilestone={milestone} onSelectArc={handlers.onSelectArc} onSelectMilestone={handlers.onSelectMilestone} />
          )}
          {(arcs?.archived ?? []).length > 0 && (
            <details className="flow-archived">
              <summary>{`Archived arcs (${arcs.archived.length})`}</summary>
              <ul className="flow-unlinked">
                {arcs.archived.map((a) => (
                  <li key={a.slug}>
                    <span>{arcName(a)}</span>{' '}
                    <button type="button" className="btn btn-small" onClick={() => handlers.onRestoreArc?.(a)}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <aside className="flow-side" aria-label="Selected arc">
          {arc ? (
            <section className="flow-panel" aria-labelledby="arc-panel-h">
              <h2 id="arc-panel-h">{`Arc of ${arcName(arc)}`}</h2>
              {milestone && <MilestoneDetails bookId={bookId} arc={arc} index={milestone.index} nodeById={nodeById} />}
              {panel}
            </section>
          ) : url.arc && arcs !== null ? (
            <section className="flow-panel">
              <h2>Arc</h2>
              <p className="muted">That arc is not there any more.</p>
            </section>
          ) : (
            <section className="flow-panel" aria-labelledby="arc-help-h">
              <h2 id="arc-help-h">Details</h2>
              <p className="muted">Select a milestone to see its details, or Edit arc to change an arc.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
