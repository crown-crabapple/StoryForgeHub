import { useState } from 'react';
import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { useStructure } from '../structure/useStructure.jsx';
import { arcName, milestoneSummary, relationshipName } from './model.js';
import {
  arcMilestonesForScene,
  arcsUrl,
  beatsForScene,
  structuresUrl,
  PLAN_FIELDS,
  fieldValue,
  linksForScene,
  linksUrl,
  planHref,
  relationLabel,
  relationshipChangesForScene,
  relationshipsUrl,
  scenePlanBody,
  scenePlanUrl,
} from './requests.js';

/** One plan field: a labelled single-line input. Enter or leaving it saves a change; Escape puts the saved text back. */
function PlanField({ id, label, saved, onSave }) {
  const [text, setText] = useState(saved);
  const [skip, setSkip] = useState(false);
  const commit = () => {
    if (skip) {
      setSkip(false);
      return;
    }
    if (fieldValue(text) !== fieldValue(saved)) onSave(fieldValue(text));
  };
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={text}
        placeholder="Not set"
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setSkip(true);
            setText(saved);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

const sceneTitle = (t) => t || 'Untitled scene';

/**
 * The presentational part of the "Plan" section.
 * @param {{ bookId: string, sceneId: string, plan: any | null, links: { links?: any[] } | null, arcs?: { arcs?: any[] } | null, relationships?: { relationships?: any[] } | null, structures?: { structures?: any[] } | null, message?: string | null, error?: string | null,
 *   onSave?: (key: string, value: string | null) => void }} props
 *   `plan` is GET /scene-plans/:sceneId (null while it loads), `links` is GET /links (null while it loads), `arcs` is GET /arcs (null while it loads or not given), `relationships` is GET /relationships (likewise), `structures` is GET /structures (likewise), `message` a short notice, `error` a refusal shown inline,
 *   `onSave(key, value)` is called for one changed field (value null when emptied).
 */
export function ScenePlanView({ bookId, sceneId, plan, links, arcs = null, relationships = null, structures = null, message = null, error = null, onSave }) {
  const { outgoing, incoming } = linksForScene(links, sceneId);
  const none = outgoing.length === 0 && incoming.length === 0;
  const milestones = arcMilestonesForScene(arcs, sceneId);
  const changes = relationshipChangesForScene(relationships, sceneId);
  const beats = beatsForScene(structures, sceneId);
  return (
    <InspectorSection title="Plan">
      {plan === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="plan-fields">
          {PLAN_FIELDS.map((f) => {
            const saved = plan.fields?.[f.key] ?? '';
            return <PlanField key={`${f.key}:${plan.sha256 ?? ''}:${saved}`} id={`plan-${f.key}`} label={f.label} saved={saved} onSave={(value) => onSave?.(f.key, value)} />;
          })}
        </div>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3 className="plan-links-heading">Links</h3>
      {links === null ? (
        <p className="muted">Loading…</p>
      ) : none ? (
        <>
          <p className="muted">Not linked to other scenes yet.</p>
          <p>
            <Link to={planHref(bookId, { view: 'flow', node: sceneId })}>Connect in Flow</Link>
          </p>
        </>
      ) : (
        <ul className="rail-links plan-links" aria-label="Links of this scene">
          {outgoing.map((l) => (
            <li key={l.id}>
              <Link to={planHref(bookId, { view: 'flow', link: l.slug })}>
                → {relationLabel(l.relation)} {sceneTitle(l.to_title)}
              </Link>
            </li>
          ))}
          {incoming.map((l) => (
            <li key={l.id}>
              <Link to={planHref(bookId, { view: 'flow', link: l.slug })}>
                {sceneTitle(l.from_title)} {relationLabel(l.relation)} →
              </Link>
            </li>
          ))}
        </ul>
      )}
      {arcs !== null && (
        <>
          <h3 className="plan-links-heading">Arc milestones in this scene</h3>
          {milestones.length === 0 ? (
            <p className="muted">No character arc has a milestone here.</p>
          ) : (
            <ul className="rail-links plan-links" aria-label="Arc milestones in this scene">
              {milestones.map(({ arc, milestone }) => (
                <li key={`${arc.slug}:${milestone.index}`}>
                  <Link to={planHref(bookId, { view: 'arcs', arc: arc.slug })}>
                    {arcName(arc)}: {milestoneSummary(milestone) || `milestone ${milestone.index + 1}`}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {relationships !== null && (
        <>
          <h3 className="plan-links-heading">Relationship changes in this scene</h3>
          {changes.length === 0 ? (
            <p className="muted">No relationship changes here.</p>
          ) : (
            <ul className="rail-links plan-links" aria-label="Relationship changes in this scene">
              {changes.map(({ relationship, development }, i) => (
                <li key={`${relationship.slug}:${i}`}>
                  <Link to={planHref(bookId, { view: 'arcs', relationship: relationship.slug })}>
                    {relationshipName(relationship)}: {development.change}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {structures !== null && (
        <>
          <h3 className="plan-links-heading">Beats in this scene</h3>
          {beats.length === 0 ? (
            <p className="muted">No beat uses this scene.</p>
          ) : (
            <ul className="rail-links plan-links" aria-label="Beats in this scene">
              {beats.map(({ structure, beat }) => (
                <li key={`${structure.slug}:${beat.id}`}>
                  <Link to={planHref(bookId, { view: 'structure', structure: structure.slug })}>{`${structure.name}: ${beat.name}`}</Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </InspectorSection>
  );
}

/**
 * The "Plan" section of the scene rail: the scene's planning fields (each saved on its own, with Undo) and its causal links.
 * @param {{ book: any, sceneId: string, onChanged?: () => void }} props
 */
export function ScenePlanSection({ book, sceneId, onChanged }) {
  const { track } = useWrites();
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => setVersion((v) => v + 1);
  const changed = (info) => {
    refresh();
    onChanged?.(info);
  };
  const structure = useStructure({ book, activeId: sceneId, onChanged: changed });
  const plan = useApi(scenePlanUrl(book.id, sceneId), version);
  const links = useApi(linksUrl(book.id), version);
  const arcs = useApi(arcsUrl(book.id), version);
  const relationships = useApi(relationshipsUrl(book.id), version);
  const structures = useApi(structuresUrl(book.id), version);

  async function save(key, value) {
    setMessage(null);
    setError(null);
    const body = scenePlanBody({ fields: { [key]: value }, sha: plan.data?.sha256 ?? null });
    const { status, json } = await track(book.id, () => send(scenePlanUrl(book.id, sceneId), body));
    if (status === 200 || status === 201) {
      structure.showToast({ message: 'Plan saved.', opId: json?.opId ?? null });
      changed(json);
    } else if (status === 409) {
      setMessage('This plan changed elsewhere; reloaded.');
      refresh();
    } else {
      setError(explainFailure(status, json));
      refresh();
    }
  }

  return (
    <>
      <ScenePlanView
        bookId={book.id}
        sceneId={sceneId}
        plan={plan.data}
        links={links.error ? { links: [] } : links.data}
        arcs={arcs.error ? { arcs: [] } : arcs.data}
        relationships={relationships.error ? { relationships: [] } : relationships.data}
        structures={structures.error ? { structures: [] } : structures.data}
        message={message}
        error={error ?? (plan.error ? 'The plan could not be loaded.' : null)}
        onSave={save}
      />
      {structure.ui}
    </>
  );
}
