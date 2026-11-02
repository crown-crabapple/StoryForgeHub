import { useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from './line-diff.js';

const MARK = { same: '', change: '~', 'left-only': '-', 'right-only': '+' };
const WORDS = { same: 'unchanged', change: 'different', 'left-only': 'only in your text', 'right-only': 'only in the file' };

/** Your text and the file on disk side by side, changed lines marked with a sign as well as a colour. */
export function CompareView({ mine, theirs }) {
  const rows = useMemo(() => diffLines(mine, theirs), [mine, theirs]);
  const changed = rows.filter((r) => r.type !== 'same').length;
  return (
    <div className="compare" role="group" aria-label="Your text compared with the file on disk">
      <p className="muted compare-summary">{changed === 0 ? 'The two texts are the same line for line.' : `${changed} ${changed === 1 ? 'line differs' : 'lines differ'}.`}</p>
      <div className="compare-scroll" tabIndex={0}>
        <table className="compare-table">
          <caption className="sr-only">Line by line comparison</caption>
          <colgroup>
            <col className="compare-col-no" />
            <col />
            <col className="compare-col-no" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" colSpan={2}>
                Your text
              </th>
              <th scope="col" colSpan={2}>
                The file on disk
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`compare-row compare-${r.type}`}>
                <td className="compare-no">{r.leftNo ?? ''}</td>
                <td className="compare-text">
                  {r.type !== 'same' && r.left !== null && (
                    <span className="compare-sign" title={WORDS[r.type]}>
                      {MARK[r.type]}
                      <span className="sr-only"> {WORDS[r.type]}: </span>
                    </span>
                  )}
                  {r.left ?? ''}
                </td>
                <td className="compare-no">{r.rightNo ?? ''}</td>
                <td className="compare-text">
                  {r.type !== 'same' && r.right !== null && (
                    <span className="compare-sign" title={WORDS[r.type]}>
                      {MARK[r.type]}
                      <span className="sr-only"> {WORDS[r.type]}: </span>
                    </span>
                  )}
                  {r.right ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The banner shown when the scene changed outside the editor. Nothing is merged: the author picks one of four things.
 * @param {{ snapshot: import('./save-controller.js').SaveSnapshot, title: string, onCheckDisk: () => any,
 *   onKeepMine: () => void, onUseFile: () => Promise<void>, onSaveCopy: () => Promise<{ ok: boolean, message?: string }> }} props
 */
export function ConflictPanel({ snapshot, title, onCheckDisk, onKeepMine, onUseFile, onSaveCopy }) {
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const theirs = snapshot.conflict?.currentText ?? null;

  // the disk text is needed to compare: ask for it if the 409 did not carry it
  const checkRef = useRef(onCheckDisk);
  useEffect(() => {
    checkRef.current = onCheckDisk;
  });
  useEffect(() => {
    if (comparing && theirs === null) checkRef.current();
  }, [comparing, theirs]);

  const guard = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && r.ok === false) setError(r.message ?? 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="editor-notice editor-notice-danger" role="alert" aria-label="This scene changed outside the editor">
      <p>
        <strong>This scene changed outside the editor.</strong> Autosave is paused so nothing is overwritten. Choose what to keep for “{title || 'Untitled scene'}”.
      </p>
      <div className="editor-notice-actions">
        <button type="button" className="btn" aria-expanded={comparing} onClick={() => setComparing((c) => !c)}>
          {comparing ? 'Hide comparison' : 'Compare'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onKeepMine}>
          Keep mine
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => guard(onUseFile)}>
          Use the file's version
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => guard(onSaveCopy)}>
          Save mine as a copy
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {comparing && (theirs === null ? <p className="muted">Reading the file…</p> : <CompareView mine={snapshot.text} theirs={theirs} />)}
    </section>
  );
}
