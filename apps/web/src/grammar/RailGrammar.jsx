// The "Grammar" section of the editor rail (M13-J02 section 5): the state of the checker in words, a Check scene button, and one card per finding with its
// replacements, Ignore, Add to dictionary (spelling) and Turn off this rule. Advice only: the text changes only when the author presses a replacement, through the
// editor's applyFinding (an ordinary edit, so Undo works). Nothing here talks to the network except the book's own settings route and Codex list.
import { useEffect, useMemo, useState } from 'react';
import { postJson, useApi } from '../api.js';
import { useEditorBridge } from '../editor/bridge.jsx';
import { mergeFindings } from '../findings/merge.js';
import { Link } from '../router.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { openHref, ruleLabel } from '../style/model.js';

const CATEGORY_LABEL = { spelling: 'Spelling', grammar: 'Grammar', punctuation: 'Punctuation', style: 'Style' };
/** What the author is told when the text under a finding changed before the replacement was applied. */
export const STALE_NOTE = 'The text changed; checking again';

/** @param {number} n */
const suggestionCount = (n) => `${n} ${n === 1 ? 'suggestion' : 'suggestions'}`;

/**
 * The state in words. "No suggestions" is said only when a check completed and found nothing.
 * @param {{ state: string, reason: string | null, findings: any[], checkedAt: string | null } | null} snapshot null while checks are off for the book
 */
export function grammarStatus(snapshot) {
  if (!snapshot || snapshot.state === 'disabled') return 'Grammar checks are off for this book.';
  const n = snapshot.findings.length;
  switch (snapshot.state) {
    case 'ready':
      return 'Loading the checker…';
    case 'running':
      return snapshot.checkedAt === null ? 'Loading the checker…' : 'Checking…';
    case 'completed':
      return n === 0 ? 'No suggestions' : suggestionCount(n);
    case 'unavailable':
      return snapshot.reason || 'Grammar checks are not available for this scene.';
    case 'failed':
      return `The grammar checker could not run${snapshot.reason ? `: ${snapshot.reason}` : '.'}`;
    case 'cancelled':
      return 'The check was cancelled.';
    default:
      return 'Grammar checks are not available.';
  }
}

/** The label of a replacement button. @param {string} text */
export const replaceLabel = (text) => (text === '' ? 'Delete' : `Replace with ‘${text}’`);

/**
 * One finding as a card. Presentational.
 * @param {{ finding: any, codexName?: boolean, busy?: boolean, onSelect: (f: any) => void, onApply: (f: any, index: number) => void, onIgnore: (f: any) => void,
 *   onAddWord: (f: any) => void, onDisableRule: (f: any) => void }} props
 */
export function GrammarCard({ finding, codexName = false, busy = false, onSelect, onApply, onIgnore, onAddWord, onDisableRule }) {
  const spelling = finding.category === 'spelling';
  const addWord = spelling && (
    <button type="button" className="btn btn-small" disabled={busy} onClick={() => onAddWord(finding)}>
      Add to dictionary
    </button>
  );
  return (
    <li className="cf-card gr-card" data-severity={finding.severity} data-category={finding.category}>
      <div className="cf-card-head">
        <span className="cf-dot" data-severity={finding.severity} aria-hidden="true" />
        <span className="cf-sev">{CATEGORY_LABEL[finding.category] ?? finding.category}</span>
        {codexName && <span className="badge gr-codex">Codex name</span>}
      </div>
      <p className="gr-flagged">
        <button type="button" className="btn btn-small gr-text" aria-label={`Show “${finding.original}” in the text`} onClick={() => onSelect(finding)}>
          {finding.original}
        </button>
      </p>
      <p className="muted gr-message">{finding.message}</p>
      <div className="cf-actions">
        {codexName && addWord}
        {finding.replacements.map((r, i) => (
          <button key={`${i}|${r}`} type="button" className="btn btn-small" onClick={() => onApply(finding, i)}>
            {replaceLabel(r)}
          </button>
        ))}
        <button type="button" className="btn btn-small" onClick={() => onIgnore(finding)}>
          Ignore
        </button>
        {!codexName && addWord}
        <button type="button" className="btn btn-small" disabled={busy} title={`Rule: ${finding.ruleId}`} onClick={() => onDisableRule(finding)}>
          Turn off this rule
        </button>
      </div>
    </li>
  );
}

/**
 * The style state in words (M13-J03). "No style suggestions" is said only when a check completed and found nothing.
 * @param {{ state: string, reason: string | null, findings: any[], checkedAt: string | null } | null} snapshot null while style checks are off for the book
 */
export function styleStatus(snapshot) {
  if (!snapshot || snapshot.state === 'disabled') return 'Style checks are off for this book.';
  const n = snapshot.findings.length;
  switch (snapshot.state) {
    case 'ready':
    case 'running':
      return 'Checking…';
    case 'completed':
      return n === 0 ? 'No style suggestions' : suggestionCount(n);
    case 'unavailable':
      return snapshot.reason || 'Style checks are not available for this scene.';
    case 'failed':
      return `Style checks could not run${snapshot.reason ? `: ${snapshot.reason}` : '.'}`;
    case 'cancelled':
      return 'The style check was cancelled.';
    default:
      return 'Style checks are not available.';
  }
}

/**
 * One style finding as a card (M13-J03): rule label, "Advice" for an advisory one, the flagged text, the message, related occurrences, replacements and Dismiss. Presentational.
 * @param {{ finding: any, bookId?: string, busy?: boolean, onSelect: (f: any) => void, onSelectRange?: (from: number, to: number) => void, onApply: (f: any, index: number) => void, onDismiss: (f: any) => void }} props
 */
export function StyleCard({ finding, bookId = '', busy = false, onSelect, onSelectRange = () => {}, onApply, onDismiss }) {
  const related = Array.isArray(finding.related) ? finding.related : [];
  return (
    <li className="cf-card gr-card st-card" data-severity={finding.severity} data-category={finding.category} data-rule={finding.ruleId}>
      <div className="cf-card-head">
        <span className="cf-dot" data-severity={finding.severity} aria-hidden="true" />
        <span className="cf-sev">{ruleLabel(finding.ruleId)}</span>
        {finding.advisory && <span className="badge st-advice">Advice</span>}
      </div>
      <p className="gr-flagged">
        <button type="button" className="btn btn-small gr-text" aria-label={`Show “${finding.original}” in the text`} onClick={() => onSelect(finding)}>
          {finding.original}
        </button>
      </p>
      <p className="muted gr-message">{finding.message}</p>
      {related.length > 0 && (
        <ul className="st-related" aria-label="Other places">
          {related.map((r) => (
            <li key={`${r.sceneId}|${r.from}|${r.to}`}>
              {r.sceneId === finding.sceneId ? (
                <button type="button" className="btn btn-small" onClick={() => onSelectRange(r.from, r.to)}>
                  {`Also here: “${r.text}”`}
                </button>
              ) : (
                <Link className="btn btn-small" to={openHref(bookId, r.sceneId, r.from, r.to)}>
                  {`In another scene: “${r.text}”`}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="cf-actions">
        {finding.replacements.map((r, i) => (
          <button key={`${i}|${r}`} type="button" className="btn btn-small" onClick={() => onApply(finding, i)}>
            {replaceLabel(r)}
          </button>
        ))}
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => onDismiss(finding)}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

/**
 * The section from the two snapshots (also used by tests): a Grammar group and a Style group. Presentational. `style` undefined leaves the Style group out (grammar only);
 * null or a disabled snapshot shows that style checks are off. A finding the other engine owns (mergeFindings) is shown once.
 * @param {{ snapshot: { state: string, reason: string | null, findings: any[], checkedAt: string | null } | null, style?: { state: string, reason: string | null, findings: any[], checkedAt: string | null } | null,
 *   bookId?: string, codexNames?: Set<string>, note?: string | null, busy?: boolean,
 *   onCheck?: () => void, onSelect?: (f: any) => void, onSelectRange?: (from: number, to: number) => void, onApply?: (f: any, index: number) => void, onIgnore?: (f: any) => void, onAddWord?: (f: any) => void,
 *   onDisableRule?: (f: any) => void, onDismiss?: (f: any) => void }} props
 */
export function GrammarPanelView({ snapshot, style = undefined, bookId = '', codexNames = new Set(), note = null, busy = false, onCheck = () => {}, onSelect = () => {}, onSelectRange = () => {}, onApply = () => {}, onIgnore = () => {}, onAddWord = () => {}, onDisableRule = () => {}, onDismiss = () => {} }) {
  const off = !snapshot || snapshot.state === 'disabled';
  const styleShown = style !== undefined;
  const styleOff = !style || style.state === 'disabled';
  const grammarAll = off ? [] : snapshot.findings;
  const styleAll = styleOff ? [] : style.findings;
  const merged = mergeFindings(grammarAll, styleAll);
  const findings = merged.filter((f) => grammarAll.includes(f));
  const styleFindings = merged.filter((f) => styleAll.includes(f));
  const total = findings.length + styleFindings.length;
  const title = (
    <>
      Checks
      {total > 0 && (
        <>
          {' '}
          <span className="badge" aria-label={suggestionCount(total)}>
            {total}
          </span>
        </>
      )}
    </>
  );
  const running = snapshot?.state === 'running' || style?.state === 'running';
  const checkButton = (
    <p>
      <button type="button" className="btn btn-small" disabled={running} onClick={onCheck}>
        Check scene
      </button>
    </p>
  );
  return (
    <InspectorSection title={title}>
      <div role="group" aria-label="Grammar" className="st-group">
        {styleShown && <h3 className="st-group-title">Grammar</h3>}
        {off ? (
          <p className="muted">
            {grammarStatus(snapshot)} Turn them on in <Link to="/settings">Settings</Link>.
          </p>
        ) : (
          <>
            <p className="muted gr-status" aria-live="polite">
              {grammarStatus({ ...snapshot, findings })}
            </p>
            {checkButton}
          </>
        )}
        {findings.length > 0 && (
          <ul className="cf-cards" aria-label="Grammar suggestions in this scene">
            {findings.map((f) => (
              <GrammarCard
                key={f.id}
                finding={f}
                codexName={f.category === 'spelling' && codexNames.has(f.original)}
                busy={busy}
                onSelect={onSelect}
                onApply={onApply}
                onIgnore={onIgnore}
                onAddWord={onAddWord}
                onDisableRule={onDisableRule}
              />
            ))}
          </ul>
        )}
      </div>
      {styleShown && (
        <div role="group" aria-label="Style" className="st-group">
          <h3 className="st-group-title">Style</h3>
          {styleOff ? (
            <p className="muted">
              {styleStatus(style)} Turn them on in <Link to="/settings">Settings</Link>.
            </p>
          ) : (
            <>
              <p className="muted gr-status" aria-live="polite">
                {styleStatus({ ...style, findings: styleFindings })}
              </p>
              {off && checkButton}
            </>
          )}
          {styleFindings.length > 0 && (
            <ul className="cf-cards" aria-label="Style suggestions in this scene">
              {styleFindings.map((f) => (
                <StyleCard key={f.id} finding={f} bookId={bookId} busy={busy} onSelect={onSelect} onSelectRange={onSelectRange} onApply={onApply} onDismiss={onDismiss} />
              ))}
            </ul>
          )}
        </div>
      )}
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
    </InspectorSection>
  );
}

/** Names and aliases of the Codex entries (GET /codex/entries), for the "Codex name" hint. @param {any} list */
export function codexNameSet(list) {
  const names = new Set();
  for (const e of Array.isArray(list?.entries) ? list.entries : []) {
    if (typeof e?.name === 'string' && e.name) names.add(e.name);
    for (const a of Array.isArray(e?.aliases) ? e.aliases : []) if (typeof a === 'string' && a) names.add(a);
  }
  return names;
}

/**
 * The rail section for the open scene: reads the editor's grammar and style controllers through the bridge and acts on them.
 * @param {{ book: any, scene: any }} props
 */
export function RailGrammar({ book, scene }) {
  const bridge = useEditorBridge();
  const [, setTick] = useState(0);
  const [note, setNote] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  // re-draw when the editor opens or closes and whenever its controller changes
  useEffect(() => {
    let off = () => {};
    const attach = () => {
      off();
      const redraw = () => setTick((n) => n + 1);
      const h = bridge.current();
      const offGrammar = h?.grammar?.subscribe(redraw) ?? (() => {});
      const offStyle = h?.style?.subscribe(redraw) ?? (() => {});
      off = () => {
        offGrammar();
        offStyle();
      };
      redraw();
    };
    attach();
    const unsubscribe = bridge.subscribe(attach);
    return () => {
      unsubscribe();
      off();
    };
  }, [bridge]);

  const handle = bridge.current();
  const open = handle && handle.sceneId === scene.id ? handle : null;
  const snapshot = open?.grammar?.snapshot() ?? null;
  const styleSnapshot = open?.style?.snapshot() ?? null;
  const on = snapshot !== null && snapshot.state !== 'disabled';
  const codex = useApi(on ? `/api/books/${encodeURIComponent(book.id)}/codex/entries` : null);
  const codexNames = useMemo(() => codexNameSet(codex.data), [codex.data]);

  const change = async (patch, done) => {
    setBusy(true);
    try {
      const r = await postJson(`/api/books/${encodeURIComponent(book.id)}/checks/grammar`, patch);
      if (r.status === 200) {
        setNote(done);
        open?.reloadGrammarSettings?.();
      } else setNote(r.json?.message ?? `Not saved (${r.status}).`);
    } catch {
      setNote('The server could not be reached.');
    }
    setBusy(false);
  };

  return (
    <GrammarPanelView
      snapshot={snapshot}
      style={styleSnapshot}
      bookId={book.id}
      codexNames={codexNames}
      note={note}
      busy={busy}
      onCheck={() => {
        setNote(null);
        open?.checkNow?.();
      }}
      onSelect={(f) => open?.selectBodyRange?.(f.range.from, f.range.to)}
      onSelectRange={(from, to) => open?.selectBodyRange?.(from, to)}
      onApply={(f, index) => {
        const r = open?.applyFinding?.(f.id, index);
        if (!r || r.ok) setNote(null);
        else if (r.code === 'STALE' || r.code === 'NOT_FOUND') {
          setNote(STALE_NOTE);
          open?.checkNow?.();
        } else if (r.code === 'READ_ONLY') setNote('You can read this scene, but not change it.');
        else setNote('That replacement is not available.');
      }}
      onIgnore={(f) => {
        setNote(null);
        open?.ignoreFinding?.(f.id);
      }}
      onDismiss={async (f) => {
        setNote(null);
        setBusy(true);
        const r = await open?.dismissStyleFinding?.(f.id);
        setBusy(false);
        if (r && !r.ok) setNote(r.code === 'NOT_FOUND' ? STALE_NOTE : (r.message ?? 'The suggestion could not be dismissed.'));
      }}
      onAddWord={(f) => change({ addWords: [f.original] }, `Added “${f.original}” to the dictionary.`)}
      onDisableRule={(f) => change({ disableRules: [f.ruleId] }, `Turned off the rule ${f.ruleId} for this book. You can turn it back on in Settings.`)}
    />
  );
}
