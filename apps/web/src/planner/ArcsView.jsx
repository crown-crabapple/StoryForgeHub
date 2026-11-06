import { useState } from 'react';
import { Link } from '../router.jsx';
import { sceneHref, viewHref } from '../planning/model.js';
import { Dialog } from '../shell/Dialog.jsx';
import { LANE_COL_W, LANE_HEAD, LANE_KINDS, LANE_LABEL_W, LANE_MARK, LANE_PAD, LANE_ROW_H, THREAD_ROLES, arcName, layoutLanes, loadLaneKinds, milestoneSummary, relationshipName, saveLaneKinds, sceneName, threadMarkerName, threadSceneIds } from './model.js';
import { ARC_TYPES, MILESTONE_FIELDS } from './requests.js';

/** "<choice> / <pressure>" for the list rows: whichever of the two are written. */
const rowSummary = (m) => [m.choice, m.pressure].filter(Boolean).join(' / ');

/**
 * The lanes: one narrow column per scene in reading order and one row per arc, relationship or plot thread, grouped by kind under a heading row. An arc milestone is a diamond with its
 * number, a relationship development a round marker with its number, a plot thread entry a square marker with the letter S (setup), D (development) or P (payoff). A marker is a button
 * whose name says who, what and where; the same things are in the List view.
 * @param {{ arcs?: any[], relationships?: any[], threads?: any[], kinds?: Record<string, boolean>, nodes: any[], selectedKey?: string | null,
 *   onSelect?: (marker: any) => void, onSelectRow?: (row: any) => void }} props
 */
export function ArcLanes({ arcs = [], relationships = [], threads = [], kinds = { arc: true, relationship: true, thread: true }, nodes, selectedKey = null, onSelect, onSelectRow }) {
  const lanes = layoutLanes(laneSources({ arcs, relationships, threads }, kinds), nodes);
  return (
    <div className="arc-lanes-scroll">
      <div className="arc-lanes" role="group" aria-label="Lanes of character arcs, relationships and plot threads. The same things are in the List view." style={{ width: lanes.width, height: lanes.height }}>
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
        {lanes.rows.map((r) =>
          r.heading ? (
            <h3 key={`h:${r.kind}`} className="ln-heading" style={{ top: r.y, height: r.height, width: lanes.width }}>
              {r.label}
            </h3>
          ) : (
            <div key={`${r.kind}:${r.slug}`} className="arc-lane" style={{ top: r.y, height: LANE_ROW_H, width: lanes.width }}>
              {r.kind === 'relationship' ? (
                <button type="button" className="arc-lane-name ln-lane-button" style={{ width: LANE_LABEL_W }} aria-label={`Edit the relationship ${r.name}`} onClick={() => onSelectRow?.(r)}>
                  {r.name}
                </button>
              ) : (
                <span className="arc-lane-name" style={{ width: LANE_LABEL_W }}>
                  {r.name}
                </span>
              )}
              <span className="arc-lane-line" style={{ left: LANE_LABEL_W, top: LANE_ROW_H / 2 }} aria-hidden="true" />
            </div>
          ),
        )}
        {lanes.rows
          .filter((r) => !r.heading)
          .flatMap((r) =>
            r.markers.map((m) => (
              <button
                key={m.key}
                type="button"
                className={m.kind === 'arc' ? 'arc-marker' : `ln-marker ln-marker-${m.kind}`}
                aria-label={m.name}
                aria-pressed={selectedKey === m.key}
                style={{ left: m.x, top: m.y, width: LANE_MARK, height: LANE_MARK }}
                onClick={() => onSelect?.(m)}
              >
                <span aria-hidden="true">{m.text}</span>
              </button>
            )),
          )}
      </div>
      {lanes.unplaced > 0 && <p className="muted">{`${lanes.unplaced} ${lanes.unplaced === 1 ? 'milestone points' : 'milestones point'} to a scene that is not in the book; the List shows ${lanes.unplaced === 1 ? 'it' : 'them'}.`}</p>}
      {lanes.unplacedOther > 0 && (
        <p className="muted">{`${lanes.unplacedOther} ${lanes.unplacedOther === 1 ? 'marker of a relationship or plot thread points' : 'markers of relationships or plot threads point'} to a scene that is not in the book; the List shows ${lanes.unplacedOther === 1 ? 'it' : 'them'}.`}</p>
      )}
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

/** The lane sources of `layoutLanes` for the kinds that are on: arcs, then relationships, then plot threads. */
function laneSources({ arcs, relationships, threads }, kinds) {
  return [
    { kind: 'arc', items: kinds.arc ? arcs : [] },
    { kind: 'relationship', items: kinds.relationship ? relationships : [] },
    { kind: 'thread', items: kinds.thread ? threads : [] },
  ].filter((g) => g.items.length > 0);
}

/** The list of relationships: per relationship a heading, its baseline and end state, and its developments in order, as rows "<scene> — <change>" with each side's view. */
export function RelationshipList({ relationships, nodeById, selected, selectedDevelopment, onSelectRelationship, onSelectDevelopment }) {
  return (
    <div className="arc-list ln-relationship-list">
      {relationships.map((rel) => {
        const name = relationshipName(rel);
        const a = rel.a?.name ?? 'A';
        const b = rel.b?.name ?? 'B';
        return (
          <section key={rel.slug} className="plan-block arc-list-arc" aria-labelledby={`rel-h-${rel.slug}`} aria-current={rel.slug === selected ? 'true' : undefined}>
            <h3 id={`rel-h-${rel.slug}`}>{name}</h3>
            {(rel.baseline || rel.end_state) && <p className="muted">{[rel.baseline && `Baseline: ${rel.baseline}`, rel.end_state && `Ends as: ${rel.end_state}`].filter(Boolean).join(' · ')}</p>}
            <p>
              <button type="button" className="btn btn-small" aria-label={`Edit the relationship ${name}`} onClick={() => onSelectRelationship?.(rel.slug)}>
                Edit relationship
              </button>
            </p>
            {(rel.developments ?? []).length === 0 ? (
              <p className="muted">No developments yet.</p>
            ) : (
              <ol className="arc-rows">
                {rel.developments.map((d, i) => {
                  const title = sceneName(nodeById.get(d.scene)?.title ?? d.scene_title);
                  return (
                    <li key={`${d.scene}:${i}`} className="arc-row" aria-current={selectedDevelopment?.slug === rel.slug && selectedDevelopment?.index === i ? 'true' : undefined}>
                      <button type="button" className="flow-scene-button" aria-label={`Development ${i + 1} of ${name}: ${title}`} onClick={() => onSelectDevelopment?.(rel.slug, i)}>
                        {title}
                      </button>
                      {!nodeById.has(d.scene) && <span className="tag"> missing scene</span>}
                      {d.change ? ` — ${d.change}` : ''}
                      {d.a_view && <span className="muted arc-row-belief">{`How ${a} sees ${b}: ${d.a_view}`}</span>}
                      {d.b_view && <span className="muted arc-row-belief">{`How ${b} sees ${a}: ${d.b_view}`}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** The list of plot threads: per thread a heading and one row per scene that sets it up (S), develops it (D) or pays it off (P). Read-only here. */
export function ThreadList({ threads, nodeById, selected, onSelectThread }) {
  return (
    <div className="arc-list ln-thread-list">
      {threads.map((t) => (
        <section key={t.slug} className="plan-block arc-list-arc" aria-labelledby={`thread-h-${t.slug}`}>
          <h3 id={`thread-h-${t.slug}`}>
            {t.title || t.slug}
            {t.status && <span className="muted arc-list-type">{` · ${t.status}`}</span>}
          </h3>
          {THREAD_ROLES.every((r) => threadSceneIds(t[r.key]).length === 0) ? (
            <p className="muted">No scenes yet.</p>
          ) : (
            <ul className="arc-rows ln-thread-rows">
              {THREAD_ROLES.flatMap((r) =>
                threadSceneIds(t[r.key]).map((scene) => {
                  const title = sceneName(nodeById.get(scene)?.title);
                  return (
                    <li key={`${r.key}:${scene}`} className="arc-row" aria-current={selected?.slug === t.slug && selected?.role === r.key && selected?.scene === scene ? 'true' : undefined}>
                      <span className="ln-letter" aria-hidden="true">
                        {r.letter}
                      </span>{' '}
                      <button type="button" className="flow-scene-button" aria-label={threadMarkerName(t, r.key, title)} onClick={() => onSelectThread?.({ slug: t.slug, role: r.key, scene })}>
                        {title}
                      </button>
                      <span className="muted">{` — ${r.word}`}</span>
                      {!nodeById.has(scene) && <span className="tag"> missing scene</span>}
                    </li>
                  );
                }),
              )}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** The details of one relationship development, with a link to its scene. */
function DevelopmentDetails({ bookId, relationship, index, nodeById }) {
  const d = (relationship.developments ?? [])[index];
  if (!d) return null;
  const node = nodeById.get(d.scene);
  const a = relationship.a?.name ?? 'A';
  const b = relationship.b?.name ?? 'B';
  return (
    <section className="arc-milestone-details" aria-labelledby="rel-dev-h">
      <h3 id="rel-dev-h">{`Development ${index + 1}: ${sceneName(node?.title ?? d.scene_title)}`}</h3>
      <dl className="flow-ends">
        {[['Change', d.change], [`How ${a} sees ${b}`, d.a_view], [`How ${b} sees ${a}`, d.b_view]]
          .filter(([, v]) => v)
          .map(([label, v]) => (
            <div key={label} className="arc-detail-row">
              <dt>{label}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      {node ? (
        <p>
          <Link to={sceneHref(bookId, d.scene)}>Open scene</Link>
        </p>
      ) : (
        <p className="muted">That scene is not in the book any more.</p>
      )}
    </section>
  );
}

/** The side panel of a selected thread marker: which thread, its role in which scene, and links to the thread on the Threads view and to the scene. */
function ThreadDetails({ bookId, thread, selected, nodeById }) {
  const role = THREAD_ROLES.find((r) => r.key === selected.role);
  const node = nodeById.get(selected.scene);
  return (
    <section className="flow-panel" aria-labelledby="thread-panel-h">
      <h2 id="thread-panel-h">{`Thread: ${thread.title || thread.slug}`}</h2>
      <p>{`${role ? role.word[0].toUpperCase() + role.word.slice(1) : 'Entry'} in ${sceneName(node?.title)}`}</p>
      <p className="muted">Plot threads are edited on the Threads view of the manuscript.</p>
      <p>
        <Link to={viewHref(bookId, 'threads', { thread: thread.slug })}>Open thread</Link>
      </p>
      {node ? (
        <p>
          <Link to={sceneHref(bookId, selected.scene)}>Open scene</Link>
        </p>
      ) : (
        <p className="muted">That scene is not in the book any more.</p>
      )}
    </section>
  );
}

/**
 * The Lanes view of the Plan tab (URL `?view=arcs`): lanes (wide screens) or a list of character arcs, relationships and plot threads, a checkbox per kind (remembered in this browser),
 * and the side panel for the selected arc (`panel`, the ArcEditor), relationship (`relationshipPanel`, the RelationshipEditor), milestone, development or thread marker. Presentational.
 * @param {{ bookId: string, arcs: { arcs: any[], archived?: any[] } | null, relationships?: { relationships: any[], archived?: any[] } | null, threads?: { threads: any[] } | null,
 *   flow: { nodes: any[] } | null, url: ReturnType<typeof import('./model.js').parsePlanSearch>, wide?: boolean, initialKinds?: Record<string, boolean>,
 *   selectedMilestone?: { slug: string, index: number } | null, selectedDevelopment?: { slug: string, index: number } | null, selectedThread?: { slug: string, role: string, scene: string } | null,
 *   panel?: import('react').ReactNode, relationshipPanel?: import('react').ReactNode, canCreate?: boolean,
 *   handlers?: { onMode?: (mode: 'list' | 'graph') => void, onNewArc?: () => void, onNewRelationship?: () => void, onSelectArc?: (slug: string) => void, onSelectMilestone?: (slug: string, index: number) => void,
 *     onSelectRelationship?: (slug: string) => void, onSelectDevelopment?: (slug: string, index: number) => void, onSelectThread?: (sel: { slug: string, role: string, scene: string }) => void,
 *     onRestoreArc?: (arc: any) => void, onRestoreRelationship?: (rel: any) => void } }} props
 *   `wide` is true from 768 px up: below that only the list is shown. Without `url.mode` the lanes are the default on wide screens (`mode=graph`).
 */
export function ArcsView({
  bookId,
  arcs,
  relationships = null,
  threads = null,
  flow,
  url,
  wide = true,
  initialKinds,
  selectedMilestone = null,
  selectedDevelopment = null,
  selectedThread = null,
  panel = null,
  relationshipPanel = null,
  canCreate = true,
  handlers = {},
}) {
  const [kinds, setKinds] = useState(() => initialKinds ?? loadLaneKinds());
  const toggle = (key) =>
    setKinds((k) => {
      const next = { ...k, [key]: !k[key] };
      saveLaneKinds(next);
      return next;
    });
  const nodes = flow?.nodes ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const live = arcs?.arcs ?? [];
  const liveRelationships = relationships?.relationships ?? [];
  const liveThreads = threads?.threads ?? [];
  const mode = wide ? (url.mode ?? 'graph') : 'list';
  const arc = url.arc ? live.find((a) => a.slug === url.arc) : null;
  const relationship = !arc && url.relationship ? liveRelationships.find((r) => r.slug === url.relationship) : null;
  const milestone = arc && selectedMilestone?.slug === arc.slug ? selectedMilestone : null;
  const development = relationship && selectedDevelopment?.slug === relationship.slug ? selectedDevelopment : null;
  const thread = !arc && !relationship && !url.relationship && selectedThread ? liveThreads.find((t) => t.slug === selectedThread.slug) : null;
  const selectedKey = milestone
    ? `${milestone.slug}:${milestone.index}`
    : development
      ? `rel:${development.slug}:${development.index}`
      : thread
        ? `thread:${selectedThread.slug}:${selectedThread.role}:${selectedThread.scene}`
        : null;
  const nothing = live.length === 0 && liveRelationships.length === 0 && liveThreads.length === 0;
  const shownNone = !nothing && !(kinds.arc && live.length > 0) && !(kinds.relationship && liveRelationships.length > 0) && !(kinds.thread && liveThreads.length > 0);
  const onMarker = (m) => {
    if (m.kind === 'arc') handlers.onSelectMilestone?.(m.slug, m.index);
    else if (m.kind === 'relationship') handlers.onSelectDevelopment?.(m.slug, m.index);
    else handlers.onSelectThread?.({ slug: m.slug, role: m.role, scene: m.scene });
  };
  return (
    <div className="plan-arcs">
      <div className="flow-toolbar">
        <div className="flow-mode" role="group" aria-label="Show lanes as">
          <button type="button" className="btn" aria-pressed={mode === 'list'} onClick={() => handlers.onMode?.('list')}>
            List
          </button>
          <button type="button" className="btn" aria-pressed={mode === 'graph'} disabled={!wide} onClick={() => handlers.onMode?.('graph')}>
            Lanes
          </button>
        </div>
        <fieldset className="ln-kinds">
          <legend>Show</legend>
          {LANE_KINDS.map((k) => (
            <label key={k.key} className="ln-kind">
              <input type="checkbox" checked={kinds[k.key] !== false} onChange={() => toggle(k.key)} />
              {k.label}
            </label>
          ))}
        </fieldset>
        <button type="button" className="btn btn-primary" onClick={() => handlers.onNewArc?.()} disabled={!canCreate}>
          New arc…
        </button>
        <button type="button" className="btn btn-primary" onClick={() => handlers.onNewRelationship?.()} disabled={!canCreate}>
          New relationship…
        </button>
      </div>
      {!wide && <p className="muted flow-note">The lanes need a screen at least 768 px wide. The list has every milestone, development and thread entry.</p>}
      <div className="flow-body">
        <div className="flow-main">
          {arcs === null || flow === null ? (
            <p className="muted">Loading…</p>
          ) : nothing ? (
            <p>No arcs yet. Start one from a character&apos;s Codex page or with New arc.</p>
          ) : shownNone ? (
            <p className="muted">Every kind of lane is hidden. Tick one above to show it.</p>
          ) : mode === 'graph' ? (
            <ArcLanes
              arcs={live}
              relationships={liveRelationships}
              threads={liveThreads}
              kinds={kinds}
              nodes={nodes}
              selectedKey={selectedKey}
              onSelect={onMarker}
              onSelectRow={(row) => handlers.onSelectRelationship?.(row.slug)}
            />
          ) : (
            <>
              {kinds.arc && live.length > 0 && (
                <section aria-labelledby="ln-arcs-h">
                  <h2 id="ln-arcs-h" className="ln-kind-heading">
                    Character arcs
                  </h2>
                  <ArcList arcs={live} nodeById={nodeById} selected={url.arc} selectedMilestone={milestone} onSelectArc={handlers.onSelectArc} onSelectMilestone={handlers.onSelectMilestone} />
                </section>
              )}
              {kinds.relationship && liveRelationships.length > 0 && (
                <section aria-labelledby="ln-relationships-h">
                  <h2 id="ln-relationships-h" className="ln-kind-heading">
                    Relationships
                  </h2>
                  <RelationshipList
                    relationships={liveRelationships}
                    nodeById={nodeById}
                    selected={url.relationship}
                    selectedDevelopment={development}
                    onSelectRelationship={handlers.onSelectRelationship}
                    onSelectDevelopment={handlers.onSelectDevelopment}
                  />
                </section>
              )}
              {kinds.thread && liveThreads.length > 0 && (
                <section aria-labelledby="ln-threads-h">
                  <h2 id="ln-threads-h" className="ln-kind-heading">
                    Plot threads
                  </h2>
                  <ThreadList threads={liveThreads} nodeById={nodeById} selected={selectedThread} onSelectThread={handlers.onSelectThread} />
                </section>
              )}
            </>
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
          {(relationships?.archived ?? []).length > 0 && (
            <details className="flow-archived">
              <summary>{`Archived relationships (${relationships.archived.length})`}</summary>
              <ul className="flow-unlinked">
                {relationships.archived.map((r) => (
                  <li key={r.slug}>
                    <span>{relationshipName(r)}</span>{' '}
                    <button type="button" className="btn btn-small" aria-label={`Restore the relationship ${relationshipName(r)}`} onClick={() => handlers.onRestoreRelationship?.(r)}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <aside className="flow-side" aria-label="Selected item">
          {arc ? (
            <section className="flow-panel" aria-labelledby="arc-panel-h">
              <h2 id="arc-panel-h">{`Arc of ${arcName(arc)}`}</h2>
              {milestone && <MilestoneDetails bookId={bookId} arc={arc} index={milestone.index} nodeById={nodeById} />}
              {panel}
            </section>
          ) : relationship ? (
            <section className="flow-panel" aria-labelledby="rel-panel-h">
              <h2 id="rel-panel-h">{`Relationship: ${relationshipName(relationship)}`}</h2>
              {development && <DevelopmentDetails bookId={bookId} relationship={relationship} index={development.index} nodeById={nodeById} />}
              {relationshipPanel}
            </section>
          ) : url.relationship && relationships !== null ? (
            <section className="flow-panel">
              <h2>Relationship</h2>
              <p className="muted">That relationship is not there any more.</p>
            </section>
          ) : thread ? (
            <ThreadDetails bookId={bookId} thread={thread} selected={selectedThread} nodeById={nodeById} />
          ) : url.arc && arcs !== null ? (
            <section className="flow-panel">
              <h2>Arc</h2>
              <p className="muted">That arc is not there any more.</p>
            </section>
          ) : (
            <section className="flow-panel" aria-labelledby="arc-help-h">
              <h2 id="arc-help-h">Details</h2>
              <p className="muted">Select a marker to see its details, or Edit arc or Edit relationship to change one.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
