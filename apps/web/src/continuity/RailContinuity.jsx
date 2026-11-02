import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { useEditorBridge } from '../editor/bridge.jsx';
import { Link } from '../router.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { pathsOf } from '../structure/helpers.js';
import { ShowBoth, SourceLink } from './ShowBoth.jsx';
import { bodyLineOf, continuityHref, editorMarks, findingsForScene, frontMatterLines, SEVERITY_LABEL, sourceLabel } from './model.js';
import { RAW_URL } from './requests.js';
import { useContinuityActions } from './useContinuityActions.jsx';

/**
 * One finding as a card in the rail: severity, title, a one-line message, its sources as links, and the two actions. Presentational.
 * @param {{ bookId: string, finding: any, version?: string, onSource?: (source: any) => boolean | void, onAcknowledge?: (finding: any) => void }} props
 *   `onSource(source)` may handle a click on a source itself (return true), as the rail does for the open scene.
 */
export function FindingCard({ bookId, finding, version = '', onSource, onAcknowledge }) {
  const [both, setBoth] = useState(false);
  return (
    <li className="cf-card" data-severity={finding.severity}>
      <div className="cf-card-head">
        <span className="cf-dot" data-severity={finding.severity} aria-hidden="true" />
        <span className="cf-sev">{SEVERITY_LABEL[finding.severity] ?? finding.severity}</span>
        <strong className="cf-card-title">{finding.title}</strong>
      </div>
      <p className="muted cf-message" title={finding.message}>
        {finding.message}
      </p>
      <ul className="rail-links cf-sources">
        {finding.sources.map((s, i) => (
          <li key={`${s.file}|${s.line}|${i}`}>
            <SourceLink bookId={bookId} source={s} onBefore={onSource}>
              {sourceLabel(s)}
            </SourceLink>
          </li>
        ))}
      </ul>
      <div className="cf-actions">
        <button type="button" className="btn btn-small" aria-expanded={both} onClick={() => setBoth((b) => !b)}>
          {both ? 'Hide' : 'Show both'}
        </button>
        {onAcknowledge && (
          <button type="button" className="btn btn-small" onClick={() => onAcknowledge(finding)}>
            Acknowledge…
          </button>
        )}
      </div>
      {both && <ShowBoth bookId={bookId} finding={finding} version={version} stacked />}
    </li>
  );
}

/**
 * The "Continuity" section of the editor rail (M05-J02): the findings that have a source in the open scene, errors first, with a count in the title. Advice only: it never opens
 * a window by itself, never blocks typing or saving, and never changes the text; the underline in the editor is a decoration.
 * @param {{ book: any, scene: any, continuity: { findings: any[] } | null, version?: string, onChanged?: () => void }} props `continuity` is GET /continuity (null while it loads)
 */
export function RailContinuity({ book, scene, continuity, version = '', onChanged }) {
  const bridge = useEditorBridge();
  const readable = !scene.problem && !scene.raw;
  const found = useMemo(() => (continuity ? findingsForScene(continuity, scene.id) : []), [continuity, scene.id]);
  const actions = useContinuityActions({ bookId: book.id, onChanged });

  // the front matter's line count turns a file line into a line of the editor text (read again whenever the file changes)
  const raw = useApi(readable ? RAW_URL(book.id, pathsOf(book, scene.path).bookRel) : null, scene.sha256 ?? '');
  const frontLines = raw.data?.body === undefined ? null : frontMatterLines(raw.data.body);
  const marks = useMemo(() => (frontLines === null ? [] : editorMarks(found, scene.id, frontLines)), [found, scene.id, frontLines]);
  const marksKey = JSON.stringify(marks);
  useEffect(() => {
    if (readable && continuity && frontLines !== null) bridge.setContinuityMarks(scene.id, JSON.parse(marksKey));
  }, [bridge, readable, continuity, frontLines, marksKey, scene.id]);

  const selectInEditor = (source) => {
    if (source.kind !== 'scene' || source.id !== scene.id || !source.range || frontLines === null) return false;
    const line = bodyLineOf(source.line, frontLines);
    const open = bridge.current();
    if (line === null || !open?.selectRange || open.sceneId !== scene.id) return false;
    open.selectRange(line, source.range.from, source.range.to);
    return true;
  };

  const title = (
    <>
      Continuity
      {found.length > 0 && (
        <>
          {' '}
          <span className="badge" aria-label={`${found.length} ${found.length === 1 ? 'finding' : 'findings'}`}>
            {found.length}
          </span>
        </>
      )}
    </>
  );
  return (
    <InspectorSection title={title}>
      {continuity === null ? (
        <p className="muted">Loading…</p>
      ) : found.length === 0 ? (
        <p className="muted">No continuity findings for this scene.</p>
      ) : (
        <ul className="cf-cards" aria-label="Continuity findings in this scene">
          {found.map((f) => (
            <FindingCard key={f.fingerprint} bookId={book.id} finding={f} version={version} onSource={selectInEditor} onAcknowledge={actions.acknowledge} />
          ))}
        </ul>
      )}
      {continuity !== null && (
        <p>
          <Link to={continuityHref(book.id)}>Review all ({continuity.findings.length})</Link>
        </p>
      )}
      {actions.ui}
    </InspectorSection>
  );
}
