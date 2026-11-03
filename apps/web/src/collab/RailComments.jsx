import { useId, useState } from 'react';
import { useApi } from '../api.js';
import { frontMatterLines } from '../continuity/model.js';
import { RAW_URL, sendRequest } from '../continuity/requests.js';
import { useEditorBridge } from '../editor/bridge.jsx';
import { selectionLines } from '../receipts/model.js';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { useWrites } from '../shell/writes.jsx';
import { pathsOf } from '../structure/helpers.js';
import { useSession } from '../shared/session.jsx';
import { abilities, commentCreateRequest, commentReplyRequest, commentStatusRequest, commentsUrl, explainCommentFailure, readComment, splitComments, suggestRequest } from './model.js';

const day = (iso) => String(iso).slice(0, 10);

/** One comment with its replies, a reply box, and Resolve / Reopen. Presentational. */
export function CommentThread({ comment: c, number, canComment, busy = false, onReply, onStatus, onShow }) {
  const id = useId();
  const [text, setText] = useState('');
  const who = c.by ?? 'Someone';
  return (
    <li className="cmt-thread" data-status={c.status} aria-label={`Comment ${number} by ${who}`}>
      <p className="cmt-head">
        <strong>{who}</strong> <span className="muted">{day(c.created)}</span>
        {c.status === 'resolved' && <span className="sg-chip" data-status="accepted">Resolved</span>}
      </p>
      {c.quote && <blockquote className="cmt-quote">{c.quote}</blockquote>}
      {!c.anchored && <p className="muted cmt-lost">The text this was about has changed, so it cannot be shown in place.</p>}
      <p className="cmt-text">{c.text}</p>
      {c.replies.length > 0 && (
        <ul className="cmt-replies" aria-label={`Replies to comment ${number}`}>
          {c.replies.map((r, i) => (
            <li key={`${r.at}-${i}`}>
              <strong>{r.name}</strong> <span className="muted">{day(r.at)}</span>
              <p className="cmt-text">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="cmt-actions">
        {c.anchored && onShow && (
          <button type="button" className="btn btn-small" aria-label={`Show comment ${number} in the text`} onClick={() => onShow(c)}>
            Show in text
          </button>
        )}
        {canComment && (
          <button type="button" className="btn btn-small" disabled={busy} aria-label={c.status === 'open' ? `Resolve comment ${number}` : `Reopen comment ${number}`} onClick={() => onStatus?.(c.id, c.status === 'open' ? 'resolved' : 'open')}>
            {c.status === 'open' ? 'Resolve' : 'Reopen'}
          </button>
        )}
      </div>
      {canComment && (
        <form
          className="cmt-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() === '') return;
            Promise.resolve(onReply?.(c.id, text)).then((ok) => ok && setText(''));
          }}
        >
          <label htmlFor={`${id}-reply`} className="sr-only">
            Reply to comment {number}
          </label>
          <textarea id={`${id}-reply`} className="input" rows={2} value={text} placeholder="Reply…" onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn btn-small" disabled={busy || text.trim() === ''} aria-label={`Send reply to comment ${number}`}>
            Reply
          </button>
        </form>
      )}
    </li>
  );
}

/** The two forms a reviewer fills in for the selected text: a comment, or a suggested replacement. Presentational. */
export function SelectionForm({ mode, selectedText, busy = false, error = null, onComment, onSuggest, onCancel }) {
  const id = useId();
  const [text, setText] = useState('');
  const [replacement, setReplacement] = useState(selectedText ?? '');
  const [why, setWhy] = useState('');
  if (mode === 'comment') {
    return (
      <form
        className="cmt-form"
        aria-label="Comment on the selected text"
        onSubmit={(e) => {
          e.preventDefault();
          onComment?.(text);
        }}
      >
        {selectedText && <blockquote className="cmt-quote">{selectedText}</blockquote>}
        <label htmlFor={`${id}-text`}>Your comment</label>
        <textarea id={`${id}-text`} className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="cmt-actions">
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || text.trim() === ''}>
            Add comment
          </button>
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <form
      className="cmt-form"
      aria-label="Suggest a change to the selected text"
      onSubmit={(e) => {
        e.preventDefault();
        onSuggest?.({ replacement, rationale: why });
      }}
    >
      {selectedText && <blockquote className="cmt-quote">{selectedText}</blockquote>}
      <label htmlFor={`${id}-new`}>Your version of this text</label>
      <textarea id={`${id}-new`} className="input" rows={4} value={replacement} onChange={(e) => setReplacement(e.target.value)} />
      <label htmlFor={`${id}-why`}>Why (optional)</label>
      <input id={`${id}-why`} className="input" type="text" value={why} onChange={(e) => setWhy(e.target.value)} />
      <p className="muted">The author decides. Nothing in the text changes until they accept it.</p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="cmt-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={busy || replacement === selectedText}>
          Send suggestion
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The comments of a scene, open ones first, resolved ones folded away. Presentational: the callbacks do the writing.
 * @param {{ comments: ReturnType<typeof readComment>[], canComment: boolean, busy?: boolean, onReply?: (id: string, text: string) => Promise<boolean> | void,
 *   onStatus?: (id: string, status: 'open' | 'resolved') => void, onShow?: (c: ReturnType<typeof readComment>) => void }} props
 */
export function CommentList({ comments, canComment, busy = false, onReply, onStatus, onShow }) {
  const { open, resolved } = splitComments(comments);
  return (
    <>
      {open.length === 0 ? (
        <p className="muted">No open comments on this scene.</p>
      ) : (
        <ul className="cmt-threads" aria-label="Open comments">
          {open.map((c, i) => (
            <CommentThread key={c.id} comment={c} number={i + 1} canComment={canComment} busy={busy} onReply={onReply} onStatus={onStatus} onShow={onShow} />
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="cmt-resolved">
          <summary>Resolved ({resolved.length})</summary>
          <ul className="cmt-threads" aria-label="Resolved comments">
            {resolved.map((c, i) => (
              <CommentThread key={c.id} comment={c} number={open.length + i + 1} canComment={canComment} busy={busy} onReply={onReply} onStatus={onStatus} onShow={onShow} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The "Comments" section of the editor rail (M07-J03b): the comments of the open scene, and (for reviewers and up) Comment / Suggest change for the text selected in the
 * editor. A comment is a note anchored to lines; it never changes the scene and is never exported. Reviewers cannot edit: Suggest change sends their version to the author.
 * @param {{ book: any, scene: any, version?: string, onChanged?: () => void }} props
 */
export function RailComments({ book, scene, version = '', onChanged }) {
  const session = useSession();
  const can = abilities(session);
  const bridge = useEditorBridge();
  const { track } = useWrites();
  const [stamp, setStamp] = useState(0);
  const [mode, setMode] = useState(/** @type {'comment' | 'suggest' | null} */ (null));
  const [picked, setPicked] = useState(/** @type {{ from: number, to: number, text: string, lines: { from: number, to: number } } | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [note, setNote] = useState(/** @type {string | null} */ (null));
  const { data, error: loadError } = useApi(commentsUrl(book.id, scene.id), `${version}|${stamp}`);
  // the server counts lines of the file, front matter included; the editor shows only the body
  const raw = useApi(!scene.problem && !scene.raw ? RAW_URL(book.id, pathsOf(book, scene.path).bookRel) : null, scene.sha256 ?? '');
  const front = raw.data?.body === undefined || raw.data === null ? null : frontMatterLines(raw.data.body);
  const comments = data ? (Array.isArray(data.comments) ? data.comments : []).map(readComment) : null;

  const send = async (r) => {
    setBusy(true);
    setError(null);
    const out = await track(book.id, () => sendRequest(r));
    setBusy(false);
    return out;
  };

  function start(next) {
    const handle = bridge.current();
    const sel = handle?.selection?.() ?? null;
    if (!handle || !sel || front === null) {
      setMode(null);
      setNote(front === null && sel ? 'The scene is still loading. Try again in a moment.' : 'Select some text in the editor first.');
      return;
    }
    setNote(null);
    setError(null);
    setPicked({ ...sel, lines: selectionLines(handle.text?.() ?? '', sel.from, sel.to) });
    setMode(next);
  }

  async function addComment(text) {
    if (!picked || front === null) return;
    const lines = picked.lines;
    const { status, json } = await send(commentCreateRequest(book.id, { target: scene.id, line: lines.from + front, lines: lines.to - lines.from + 1, quote: picked.text.slice(0, 500), text }));
    if (status === 201) {
      setMode(null);
      setPicked(null);
      setStamp((n) => n + 1);
      onChanged?.();
    } else setError(explainCommentFailure(status, json));
  }

  async function suggest({ replacement, rationale }) {
    if (!picked) return;
    const { status, json } = await send(suggestRequest(book.id, { target: scene.id, from: picked.from, to: picked.to, replacement, rationale }));
    if (status === 201) {
      setMode(null);
      setPicked(null);
      setNote('Your suggestion was sent to the author.');
      onChanged?.();
    } else setError(explainCommentFailure(status, json));
  }

  async function reply(id, text) {
    const { status, json } = await send(commentReplyRequest(book.id, id, text));
    if (status === 200) {
      setStamp((n) => n + 1);
      return true;
    }
    setError(explainCommentFailure(status, json));
    return false;
  }

  async function setState(id, status) {
    const r = await send(commentStatusRequest(book.id, id, status));
    if (r.status === 200) setStamp((n) => n + 1);
    else setError(explainCommentFailure(r.status, r.json));
  }

  const show = (c) => {
    if (c.line !== null && front !== null) bridge.current()?.jumpToLine?.(Math.max(1, c.line - front));
  };

  const openCount = comments ? comments.filter((c) => c.status === 'open').length : 0;
  const title = (
    <>
      Comments
      {openCount > 0 && (
        <>
          {' '}
          <span className="badge" aria-label={`${openCount} open ${openCount === 1 ? 'comment' : 'comments'}`}>
            {openCount}
          </span>
        </>
      )}
    </>
  );
  return (
    <InspectorSection title={title}>
      {comments === null ? <p className="muted">{loadError ?? 'Loading…'}</p> : <CommentList comments={comments} canComment={can.comment} busy={busy} onReply={reply} onStatus={setState} onShow={show} />}
      {can.comment && mode === null && (
        <div className="cmt-actions" role="group" aria-label="For the selected text">
          <button type="button" className="btn btn-small" onClick={() => start('comment')}>
            Comment on selection
          </button>
          {can.suggest && (
            <button type="button" className="btn btn-small" onClick={() => start('suggest')}>
              Suggest change
            </button>
          )}
        </div>
      )}
      {mode !== null && picked && (
        <SelectionForm key={mode} mode={mode} selectedText={picked.text} busy={busy} error={error} onComment={addComment} onSuggest={suggest} onCancel={() => setMode(null)} />
      )}
      {mode === null && error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
    </InspectorSection>
  );
}
