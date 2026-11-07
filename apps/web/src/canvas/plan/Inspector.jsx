// The right-hand Inspector of the canvas (M10 C6): the plan of the picked card as sections of rows, with Open / Edit plan, and for a scene the beat checkboxes.
// Rows come from inspectorRows.js; the plan itself is read from usePlanData (nothing is copied).
import { useApi } from '../../api.js';
import { Link } from '../../router.jsx';
import { scenePlanUrl } from '../../planner/requests.js';
import { storyHref } from '../model.js';
import { beatListWithScene, buildInspector, canEditKind, canOpenKind } from './inspectorRows.js';
import { planItemFor } from './selectors.js';
import './plan.css';

function Row({ row }) {
  return (
    <div className={`cv-insp-row${row.warn ? ' is-warn' : ''}`}>
      <dt>{row.label}</dt>
      <dd>
        {row.items ? (
          <ul>
            {row.items.map((t, i) => (
              <li key={`${i}:${t}`}>{t}</li>
            ))}
          </ul>
        ) : (
          row.value
        )}
      </dd>
    </div>
  );
}

/** The accessible checkbox list that adds or removes a scene from the beats of the active structure. */
function BeatChoices({ choices, sceneId, writes, readOnly, headingId }) {
  const { structure, beats } = choices;
  if (beats.length === 0) return <p className="muted">{`${structure.name} has no beats yet.`}</p>;
  const handlers = writes?.structures?.handlersFor(structure);
  const busy = writes?.structures?.state?.busy === true;
  return (
    <fieldset className="cv-insp-beats" aria-labelledby={headingId} disabled={readOnly || busy || !handlers}>
      <legend className="cv-insp-legend">{`Beats of ${structure.name}`}</legend>
      {beats.map((b) => (
        <label key={b.id} className="cv-insp-check">
          <input type="checkbox" checked={b.member} onChange={(e) => handlers?.onSaveBeats(beatListWithScene(structure, b.id, sceneId, e.target.checked))} />
          <span>{b.name}</span>
        </label>
      ))}
      {writes?.structures?.state?.slug === structure.slug && writes.structures.state.error && (
        <p className="error" role="alert">
          {writes.structures.state.error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * @param {{ bookId: string, plan: any, refInfo: any, node: any, findings?: any[] | null, readOnly?: boolean, onEdit?: () => void,
 *   writes?: any, structureId?: string | null, version?: number | string }} props
 *   `writes` is the planWrites of the page (`structures.handlersFor(...).onSaveBeats` saves beats); `structureId` the structure the rail picked; `version` changes when the plan is
 *   saved elsewhere (the drawer), so the scene plan is read again.
 */
/** The Inspector's place when no card, or more than one, is picked. */
export function InspectorHint() {
  return (
    <aside className="cv-insp-hint" aria-label="Inspector">
      <p className="muted">Pick a card to see its plan</p>
    </aside>
  );
}

export function Inspector({ bookId, plan, refInfo, node, findings = null, readOnly = false, onEdit, writes = null, structureId = null, version = 0 }) {
  const isScene = refInfo?.kind === 'scene' && refInfo?.state !== 'missing';
  const scenePlan = useApi(isScene ? scenePlanUrl(bookId, refInfo.id) : null, version);
  if (!refInfo || refInfo.state === 'missing' || refInfo.state === 'archived') {
    return (
      <aside className="cv-inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="muted">{node && !refInfo ? 'This card is not part of the plan.' : 'This card points at something that is missing or archived.'}</p>
      </aside>
    );
  }
  const item = planItemFor(plan, refInfo);
  const view = buildInspector({ plan, refInfo, item, scenePlan: isScene ? (scenePlan.loading && !scenePlan.data ? undefined : scenePlan.data) : undefined, findings, structureId });
  const headingId = `cv-insp-beats-${refInfo.id}`;
  return (
    <aside className="cv-inspector" aria-label="Inspector">
      <header className="cv-insp-head">
        <p className="cv-insp-kind">{view.kindLabel}</p>
        <h2>{view.title}</h2>
        {view.path && <p className="cv-insp-path muted">{view.path}</p>}
        <div className="cv-insp-actions">
          {canOpenKind(refInfo.kind) && (
            <Link className="btn" to={storyHref(bookId, refInfo)}>
              Open
            </Link>
          )}
          {canEditKind(refInfo.kind) && !readOnly && (
            <button type="button" className="btn btn-primary" onClick={onEdit}>
              Edit plan
            </button>
          )}
        </div>
      </header>
      {view.sections.map((s) => (
        <section key={s.id} className="cv-insp-section" aria-labelledby={s.id === 'beats' ? headingId : `cv-insp-${s.id}`}>
          <h3 id={s.id === 'beats' ? headingId : `cv-insp-${s.id}`}>{s.title}</h3>
          <dl>
            {s.rows.map((r, i) => (
              <Row key={`${i}:${r.label}`} row={r} />
            ))}
          </dl>
          {s.id === 'beats' && view.beatChoices && <BeatChoices choices={view.beatChoices} sceneId={refInfo.id} writes={writes} readOnly={readOnly} headingId={headingId} />}
        </section>
      ))}
    </aside>
  );
}
