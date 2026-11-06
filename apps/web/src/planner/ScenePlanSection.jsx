import { useState } from 'react';
import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { useWrites } from '../shell/writes.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { useStructure } from '../structure/useStructure.jsx';
import { PLAN_FIELDS, fieldValue, linksForScene, linksUrl, planHref, relationLabel, scenePlanBody, scenePlanUrl } from './requests.js';

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
 * @param {{ bookId: string, sceneId: string, plan: any | null, links: { links?: any[] } | null, message?: string | null, error?: string | null,
 *   onSave?: (key: string, value: string | null) => void }} props
 *   `plan` is GET /scene-plans/:sceneId (null while it loads), `links` is GET /links (null while it loads), `message` a short notice, `error` a refusal shown inline,
 *   `onSave(key, value)` is called for one changed field (value null when emptied).
 */
export function ScenePlanView({ bookId, sceneId, plan, links, message = null, error = null, onSave }) {
  const { outgoing, incoming } = linksForScene(links, sceneId);
  const none = outgoing.length === 0 && incoming.length === 0;
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
        message={message}
        error={error ?? (plan.error ? 'The plan could not be loaded.' : null)}
        onSave={save}
      />
      {structure.ui}
    </>
  );
}
