import { useState } from 'react';
import { useApi } from '../api.js';
import { useEditorBridge } from '../editor/bridge.jsx';
import { frontMatterLines } from '../continuity/model.js';
import { RAW_URL, sendRequest } from '../continuity/requests.js';
import { pathsOf } from '../structure/helpers.js';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { useWrites } from '../shell/writes.jsx';
import { RECEIPTS_NOTE, actorLabel, badgeText, blameUrl, editorRowsOf, fileLinesOf, flushRequest, problemWords, rangesText, readBlame, readReceipt, readStatus, readSteps, receiptsUrl, selectionLines } from './model.js';

/** The integrity badge and, when something is off, the list of problems. Report only: nothing is repaired. @param {{ status: ReturnType<typeof readStatus> }} props */
export function IntegrityStatus({ status }) {
  return (
    <div className="rc-integrity">
      <p>
        <span className={`badge rc-badge rc-badge-${status?.state ?? 'pending'}`} role="status">
          {badgeText(status)}
        </span>
        {status?.receipts !== null && status?.receipts !== undefined && <span className="muted"> {status.receipts} {status.receipts === 1 ? 'receipt' : 'receipts'} checked</span>}
      </p>
      {status && status.problems.length > 0 && (
        <ul className="rc-problems" aria-label="Receipt problems">
          {status.problems.map((p, i) => (
            <li key={`${p.code}-${p.file}-${i}`} className={`rc-problem rc-problem-${p.code === 'RCPT_UNRECORDED' ? 'info' : 'error'}`}>
              <strong>{p.code}</strong>
              <div>{problemWords(p.code)}</div>
              {p.detail && <div className="muted">{p.detail}</div>}
              <div className="muted rc-path">{p.file}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One receipt's details: time, actor, hashes, ranges, diff, AI settings, parent links, file path. @param {{ receipt: ReturnType<typeof readReceipt> }} props */
export function ReceiptDetails({ receipt: r }) {
  const ai = r.ai;
  const text = r.diff || r.body;
  return (
    <dl className="rc-details">
      <dt>Receipt</dt>
      <dd className="rc-path">{r.id}</dd>
      <dt>Time</dt>
      <dd>{r.at}</dd>
      <dt>Who</dt>
      <dd>
        {actorLabel(r.actor)}
        {r.operation && <span className="muted"> ({r.operation}{r.workflow ? `, ${r.workflow}` : ''})</span>}
      </dd>
      {r.ranges.length > 0 && (
        <>
          <dt>Changed</dt>
          <dd>{rangesText(r.ranges)}</dd>
        </>
      )}
      <dt>Before</dt>
      <dd className="rc-path">{r.before || 'nothing (the file did not exist)'}</dd>
      <dt>After</dt>
      <dd className="rc-path">{r.after}</dd>
      {ai && (
        <>
          <dt>AI</dt>
          <dd>
            {[ai.provider, ai.model, ai.locality].filter(Boolean).join(', ')}
            {ai.acceptance && <span className="muted"> ({ai.acceptance})</span>}
          </dd>
          {ai.settings_sha256 && (
            <>
              <dt>Settings</dt>
              <dd className="rc-path">{ai.settings_sha256}</dd>
            </>
          )}
          {ai.prompt_sha256 && (
            <>
              <dt>Prompt</dt>
              <dd className="rc-path">{ai.prompt_sha256}</dd>
            </>
          )}
          {ai.context_sha256 && (
            <>
              <dt>Context</dt>
              <dd className="rc-path">{ai.context_sha256}</dd>
            </>
          )}
        </>
      )}
      {r.parents.length > 0 && (
        <>
          <dt>Follows</dt>
          <dd>
            {r.parents.map((p) => (
              <div key={p.id} className="rc-path">
                {p.id}
              </div>
            ))}
          </dd>
        </>
      )}
      {r.path && (
        <>
          <dt>File</dt>
          <dd className="rc-path">{r.path}</dd>
        </>
      )}
      {text && (
        <>
          <dt>Diff</dt>
          <dd>
            <pre className="rc-diff">{text}</pre>
          </dd>
        </>
      )}
    </dl>
  );
}

/** The lineage in plain words, oldest first; each step opens to the details of its receipts. @param {{ steps: ReturnType<typeof readSteps> }} props */
export function LineageList({ steps }) {
  if (steps.length === 0) return <p className="muted">No receipts for this scene yet.</p>;
  return (
    <ol className="rc-lineage" aria-label="Lineage">
      {steps.map((s) => (
        <li key={s.key} className="rc-step">
          {s.receipts.length > 0 ? (
            <details>
              <summary>{s.text}</summary>
              {s.receipts.map((r) => (
                <ReceiptDetails key={r.id} receipt={r} />
              ))}
            </details>
          ) : (
            <span>{s.text}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The "Where did this come from?" answer: for each run of selected lines, the label and the receipt that last introduced it.
 * @param {{ lines: { from: number, to: number } | null, rows: ReturnType<typeof readBlame> | null, receipts: ReturnType<typeof readReceipt>[], message?: string | null }} props
 */
export function PassagePanel({ lines, rows, receipts, message = null }) {
  if (message) return <p className="muted rc-passage-msg">{message}</p>;
  if (!lines) return null;
  if (rows === null) return <p className="muted">Loading…</p>;
  const byId = new Map(receipts.map((r) => [r.id, r]));
  return (
    <div className="rc-passage" aria-label="Where this passage came from">
      <p className="muted">{lines.from === lines.to ? `Line ${lines.from}` : `Lines ${lines.from}–${lines.to}`}</p>
      {rows.length === 0 && <p className="muted">No receipt covers these lines yet.</p>}
      <ul className="rc-blame">
        {rows.map((r) => {
          const rec = byId.get(r.receiptId);
          return (
            <li key={`${r.from}-${r.to}-${r.receiptId}`} className="rc-blame-row">
              <strong>{r.from === r.to ? `Line ${r.from}` : `Lines ${r.from}–${r.to}`}:</strong> {r.label}
              {rec && (
                <span className="muted">
                  {' '}
                  ({actorLabel(rec.actor)}
                  {rec.by ? `: ${rec.by.name}` : ''}, {rec.at.slice(0, 10)})
                </span>
              )}
              {r.unrecorded && <div className="muted">Changed since the last receipt: not recorded yet. Use Record now.</div>}
              {r.receiptId && <div className="muted rc-path">{r.receiptId}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The "Receipts" section of the editor rail (M05-J07): the scene's lineage, "Where did this come from?" for the selected passage, the integrity badge with its problem list,
 * "Record now" and the fixed not-legal-advice note. Records only: nothing here changes the scene.
 * @param {{ book: any, scene: any, version?: string, onChanged?: () => void }} props
 */
export function RailReceipts({ book, scene, version = '', onChanged }) {
  const bridge = useEditorBridge();
  const { track } = useWrites();
  const [stamp, setStamp] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const [asked, setAsked] = useState(/** @type {{ from: number, to: number } | null} */ (null));
  const [message, setMessage] = useState(/** @type {string | null} */ (null));
  const { data, error } = useApi(receiptsUrl(book.id, scene.id), `${version}|${stamp}`);
  // `asked` is in lines of the editor text; the server counts lines of the file, front matter included
  const raw = useApi(!scene.problem && !scene.raw ? RAW_URL(book.id, pathsOf(book, scene.path).bookRel) : null, scene.sha256 ?? '');
  const front = raw.data?.body === undefined ? null : frontMatterLines(raw.data.body);
  const blame = useApi(asked && front !== null ? blameUrl(book.id, scene.id, fileLinesOf(asked, front).from, fileLinesOf(asked, front).to) : null, `${version}|${stamp}|${front}`);
  const steps = data ? readSteps(data) : null;
  const status = data ? readStatus(data.status) : null;
  const receipts = data ? (Array.isArray(data.receipts) ? data.receipts : []).map(readReceipt) : [];

  function ask() {
    const handle = bridge.current();
    const sel = handle?.selection?.() ?? null;
    if (!handle || !sel) {
      setAsked(null);
      setMessage('Select some text in the editor first, then ask again.');
      return;
    }
    setMessage(null);
    setAsked(selectionLines(handle.text?.() ?? '', sel.from, sel.to));
  }

  async function recordNow() {
    setBusy(true);
    setProblem(null);
    await bridge.current()?.flush?.(); // the author's pending saves go to the file first
    const { status: code } = await track(book.id, () => sendRequest(flushRequest(book.id, scene.id)));
    setBusy(false);
    if (code === 200) {
      setStamp((n) => n + 1);
      onChanged?.();
    } else {
      setProblem('The receipt could not be written. Nothing in your scene was changed.');
    }
  }

  const blameRows =
    asked && front !== null && blame.data !== undefined ? (blame.data ? editorRowsOf(readBlame(blame.data), front) : []) : null;
  return (
    <InspectorSection title="Receipts">
      {steps === null ? <p className="muted">{error ?? 'Loading…'}</p> : <LineageList steps={steps} />}
      <div className="rc-actions">
        <button type="button" className="btn btn-small" onClick={ask}>
          Where did this come from?
        </button>
        <button type="button" className="btn btn-small" onClick={recordNow} disabled={busy}>
          {busy ? 'Recording…' : 'Record now'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="field-error">
          {problem}
        </p>
      )}
      <PassagePanel lines={asked} rows={asked && blame.loading ? null : blameRows} receipts={receipts} message={message} />
      <IntegrityStatus status={status} />
      <p className="muted rc-note">{RECEIPTS_NOTE}</p>
    </InspectorSection>
  );
}
