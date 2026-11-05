import { useRef, useState } from 'react';
import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { SuggestionReview } from '../suggestions/SuggestionReview.jsx';
import { SuggestionsGroup } from '../suggestions/SuggestionsGroup.jsx';
import { ShowBoth, SourceLink } from './ShowBoth.jsx';
import { RAW_URL } from './requests.js';
import { MakeTaskButton } from '../tasks/MakeTaskButton.jsx';
import { RULE_INFO, SEVERITY_LABEL, STATUS_FILTERS, findByFingerprint, nextRowIndex, queueModel, rationaleOf, ruleName, sourceLabel, subjectLabel } from './model.js';

/** A small severity marker: a dot and always the word, so colour is never the only cue. */
function Severity({ severity }) {
  return (
    <span className="cf-sev-mark">
      <span className="cf-dot" data-severity={severity} aria-hidden="true" />
      <span className="cf-sev">{SEVERITY_LABEL[severity] ?? severity}</span>
    </span>
  );
}

/** The fingerprint, small, with a button that copies it. */
function Fingerprint({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="cf-fingerprint">
      <span className="muted">Fingerprint </span>
      <code>{value}</code>{' '}
      <button
        type="button"
        className="btn btn-small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </p>
  );
}

/** The author's rationale: the text of the exception file (read from the file). */
function ExceptionNote({ bookId, exception, version }) {
  const { data } = useApi(RAW_URL(bookId, exception.file), version);
  const text = typeof data?.body === 'string' ? rationaleOf(data.body) : null;
  return (
    <div className="cf-exception">
      <h3>Why this is fine</h3>
      {text === null ? <p className="muted">Loading…</p> : <p className="cf-rationale">{text}</p>}
      <p className="muted">
        File: <Link to={`/books/${encodeURIComponent(bookId)}?file=${encodeURIComponent(exception.file)}`}>{exception.file}</Link>
      </p>
    </div>
  );
}

/**
 * One finding in full: message, what the rule checks, the fingerprint, its sources (each with Open), "Show both", and either Acknowledge… or, for an acknowledged one,
 * the rationale and Restore finding. Presentational.
 * @param {{ bookId: string, finding: any | null, version?: string, handlers?: { onAcknowledge?: (f: any) => void, onRestore?: (slug: string) => void } }} props
 */
export function FindingDetail({ bookId, finding, version = '', handlers = {} }) {
  const [both, setBoth] = useState(false);
  if (!finding) return <p className="muted">Select a finding to review it.</p>;
  const info = RULE_INFO[finding.rule];
  return (
    <article className="cf-detail" aria-label={finding.title}>
      <header>
        <p className="muted cf-detail-kind">
          <Severity severity={finding.severity} /> · {finding.rule} {ruleName(finding.rule)}
          {finding.exception && <span className="tag">Acknowledged</span>}
        </p>
        <h2>{finding.title}</h2>
      </header>
      <p>{finding.message}</p>
      {info && (
        <p className="muted cf-rule">
          <strong>{info.name}.</strong> {info.description}
        </p>
      )}
      <Fingerprint value={finding.fingerprint} />

      <h3>Sources</h3>
      <ul className="cf-source-list">
        {finding.sources.map((s, i) => (
          <li key={`${s.file}|${s.line}|${i}`}>
            <span className="cf-source-label">{sourceLabel(s)}</span>{' '}
            <SourceLink bookId={bookId} source={s} className="btn btn-small">
              Open
            </SourceLink>
          </li>
        ))}
      </ul>

      <div className="cf-actions">
        <button type="button" className="btn" aria-expanded={both} onClick={() => setBoth((b) => !b)}>
          {both ? 'Hide' : 'Show both'}
        </button>
        {finding.exception ? (
          handlers.onRestore && (
            <button type="button" className="btn btn-primary" onClick={() => handlers.onRestore(finding.exception.slug)}>
              Restore finding
            </button>
          )
        ) : (
          handlers.onAcknowledge && (
            <button type="button" className="btn btn-primary" onClick={() => handlers.onAcknowledge(finding)}>
              Acknowledge…
            </button>
          )
        )}
      </div>
      {!finding.exception && (
        <p className="cf-task">
          <MakeTaskButton bookId={bookId} source={{ from: 'continuity', fingerprint: finding.fingerprint }} />
        </p>
      )}
      {both && <ShowBoth bookId={bookId} finding={finding} version={version} />}
      {finding.exception && <ExceptionNote bookId={bookId} exception={finding.exception} version={version} />}
    </article>
  );
}

/** The findings as a board of cards, one card each; ↑/↓ (Home/End) move between rows, Enter opens the row. @param {{ rows: any[], selectedFp: string | null, onSelect: (fp: string) => void }} props */
export function FindingList({ rows, selectedFp, onSelect }) {
  const listRef = useRef(null);
  const selectedAt = rows.findIndex((r) => r.fingerprint === selectedFp);
  const [focusAt, setFocusAt] = useState(/** @type {number | null} */ (null));
  const tabAt = focusAt !== null ? Math.min(focusAt, rows.length - 1) : Math.max(0, selectedAt);
  return (
    <ul
      className="nt-board cf-list"
      aria-label="Findings"
      ref={listRef}
      onKeyDown={(e) => {
        const buttons = [...(listRef.current?.querySelectorAll('button.cf-row') ?? [])];
        const current = buttons.indexOf(document.activeElement);
        const next = nextRowIndex(current < 0 ? Math.max(tabAt, 0) : current, e.key, buttons.length);
        if (next === null) return;
        e.preventDefault();
        setFocusAt(next);
        buttons[next]?.focus();
      }}
    >
      {rows.map((f, i) => (
        <li key={f.fingerprint}>
          <button type="button" className="nt-card cf-row" tabIndex={i === tabAt ? 0 : -1} aria-current={f.fingerprint === selectedFp ? 'true' : undefined} onClick={() => onSelect(f.fingerprint)} onFocus={() => setFocusAt(i)}>
            <span className="cf-card-top">
              <Severity severity={f.severity} />
              <span className="tag">{ruleName(f.rule)}</span>
            </span>
            <span className="nt-card-title">{f.title}</span>
            {f.message && <span className="nt-card-excerpt muted">{f.message}</span>}
            <span className="nt-card-meta">
              <span className="muted">{subjectLabel(f.subject)}</span>
              {f.sources[0] && <span className="muted cf-card-source">{sourceLabel(f.sources[0])}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Exceptions that no longer match a finding (the facts changed): listed with Remove. @param {{ bookId: string, items: { file: string, slug: string, fingerprint: string }[], onRemove?: (slug: string) => void }} props */
export function StaleExceptions({ bookId, items, onRemove }) {
  if (items.length === 0) return null;
  return (
    <section className="cf-stale" aria-label="Exceptions that no longer match">
      <h2 className="tl-when">No longer matches a finding</h2>
      <ul className="nt-board">
        {items.map((x) => (
          <li key={x.file} className="nt-card cf-stale-row">
            <span className="nt-card-title">{x.slug}</span>
            <span className="nt-card-meta muted cf-card-source">
              <Link to={`/books/${encodeURIComponent(bookId)}?file=${encodeURIComponent(x.file)}`}>{x.file}</Link>
              <code>{x.fingerprint}</code>
            </span>
            <span className="muted">No longer matches a finding. The text or the facts changed, so this exception hides nothing.</span>
            {onRemove && (
              <span>
                <button type="button" className="btn btn-small" onClick={() => onRemove(x.slug)}>
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The × in the corner of the finding / suggestion dialog. @param {{ label: string, onClose: () => void }} props */
function CloseButton({ label, onClose }) {
  return (
    <button type="button" className="btn nt-note-close" aria-label={label} onClick={onClose}>
      ×
    </button>
  );
}

/**
 * The Continuity review (/books/:id/continuity): filters on the left, the findings as a board of cards, and the open finding (or suggestion) in a dialog. Presentational: everything arrives by props.
 * @param {{ bookId: string, result: any, filter?: { status: string, rule: string | null, subject: string | null }, selectedFp?: string | null, version?: string,
 *   handlers?: { onFilter?: (patch: Record<string, any>) => void, onSelect?: (fp: string) => void, onClose?: () => void, onAcknowledge?: (f: any) => void, onRestore?: (slug: string) => void, onRemove?: (slug: string) => void },
 *   suggestions?: any[] | null, selectedSuggestion?: any | null, selectedSuggestionId?: string | null,
 *   suggestionHandlers?: { busy?: boolean, error?: string | null, onSelect?: (id: string) => void, onAccept?: (hunkId: string) => void, onDecline?: (hunkId: string) => void, onAcceptAll?: () => void, onDeclineAll?: () => void } }} props
 *   `suggestions` (GET /suggestions) adds the "Suggestions" group to the sidebar (M05-J06); the selected one (GET /suggestions/:id) is reviewed in the dialog instead of a finding.
 */
export function ContinuityPage({ bookId, result, filter = { status: 'all', rule: null, subject: null }, selectedFp = null, version = '', handlers = {}, suggestions = null, selectedSuggestion = null, selectedSuggestionId = null, suggestionHandlers = {} }) {
  const model = queueModel(result, filter);
  const selected = findByFingerprint(result, selectedFp);
  const set = (patch) => handlers.onFilter?.(patch);
  const close = handlers.onClose ?? (() => {});
  return (
    <div className="nt cf">
      <aside aria-label="Continuity filters" className="codex-sidebar">
        <h2 className="codex-sidebar-title">Continuity</h2>
        {STATUS_FILTERS.map((s) => (
          <button key={s.key} type="button" className="codex-cat" aria-current={s.key === filter.status ? 'true' : undefined} onClick={() => set({ status: s.key })}>
            <span>{s.label}</span>
            <span className="codex-cat-count">{model.counts[s.key]}</span>
          </button>
        ))}
        <h2 className="codex-sidebar-title cf-side-title">Rule</h2>
        <button type="button" className="codex-cat" aria-current={filter.rule === null ? 'true' : undefined} onClick={() => set({ rule: null })}>
          <span>All rules</span>
        </button>
        {model.rules.map((r) => (
          <button key={r.id} type="button" className="codex-cat" aria-current={filter.rule === r.id ? 'true' : undefined} onClick={() => set({ rule: r.id })}>
            <span>
              {r.id} {r.name}
            </span>
            <span className="codex-cat-count">{r.count}</span>
          </button>
        ))}
        <h2 className="codex-sidebar-title cf-side-title">Character or entry</h2>
        <div className="cf-subject">
          <select aria-label="Character or entry" value={filter.subject ?? ''} onChange={(e) => set({ subject: e.target.value === '' ? null : e.target.value })}>
            <option value="">Everyone</option>
            {model.subjects.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} ({s.count})
              </option>
            ))}
          </select>
        </div>
        {suggestions && <SuggestionsGroup suggestions={suggestions} selectedId={selectedSuggestionId} onSelect={suggestionHandlers.onSelect} />}
      </aside>

      <main id="main" tabIndex={-1} className="nt-main">
        <div className="codex-head">
          <h1>{STATUS_FILTERS.find((s) => s.key === filter.status)?.label ?? 'Continuity'}</h1>
          <span className="codex-counts">{model.rows.length === 1 ? '1 finding' : `${model.rows.length} findings`}</span>
        </div>
        <p className="muted cf-advice">Continuity findings are advice. Nothing here changes your prose, Codex or timeline.</p>
        {model.rows.length === 0 ? (
          <div className="empty-state">
            <h2>{filter.status === 'acknowledged' ? 'Nothing acknowledged.' : 'No findings.'}</h2>
            <p>{filter.status === 'acknowledged' ? 'Findings you acknowledge are listed here, and can be restored.' : 'Nothing contradicts anything else, with these filters.'}</p>
          </div>
        ) : (
          <FindingList rows={model.rows} selectedFp={selectedFp} onSelect={(fp) => handlers.onSelect?.(fp)} />
        )}
        <StaleExceptions bookId={bookId} items={model.stale} onRemove={handlers.onRemove} />
      </main>

      {selectedSuggestion ? (
        <Dialog label="Suggestion" onClose={close} className="dialog-wide nt-note-dialog">
          <CloseButton label="Close suggestion" onClose={close} />
          <SuggestionReview key={selectedSuggestion.id} suggestion={selectedSuggestion} busy={suggestionHandlers.busy} error={suggestionHandlers.error} handlers={suggestionHandlers} />
        </Dialog>
      ) : (
        selected && (
          <Dialog label={selected.title ?? 'Finding'} onClose={close} className="dialog-wide nt-note-dialog">
            <CloseButton label="Close finding" onClose={close} />
            <FindingDetail key={selected.fingerprint} bookId={bookId} finding={selected} version={version} handlers={handlers} />
          </Dialog>
        )
      )}
    </div>
  );
}
