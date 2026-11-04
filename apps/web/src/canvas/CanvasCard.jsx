// One card on a canvas (M09-J01): how each kind looks, read-only and while editing. The board (CanvasBoard.jsx) places, selects and moves cards.
import { useEffect, useRef } from 'react';
import { Link } from '../router.jsx';
import { REF_KIND_LABEL, assetUrl, cssColor, hexToRgb, hostOf, inkOn, markdownBlocks, nodeKind, safeUrl, storyHref, swatchText, taskCounts, toggleTask } from './model.js';

/** Inline runs of a Markdown block. @param {{ runs: any[] }} props */
function Runs({ runs }) {
  return runs.map((r, i) => {
    if (r.t === 'b') return <strong key={i}>{r.text}</strong>;
    if (r.t === 'i') return <em key={i}>{r.text}</em>;
    if (r.t === 'code') return <code key={i}>{r.text}</code>;
    if (r.t === 'link')
      return (
        <a key={i} href={r.href} target="_blank" rel="noopener noreferrer" onPointerDown={(e) => e.stopPropagation()}>
          {r.text}
        </a>
      );
    return <span key={i}>{r.text}</span>;
  });
}

/** A note's (or to-do's) rendered Markdown; task boxes toggle through `onToggle(line)` (none = read-only). */
export function MarkdownView({ text, onToggle = null, label = 'Task' }) {
  const blocks = markdownBlocks(text);
  if (blocks.length === 0) return <p className="cv-empty">Empty. Double-click to write.</p>;
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(<ul key={`l${out.length}`}>{list}</ul>);
    list = null;
  };
  blocks.forEach((b, i) => {
    if (b.type === 'li' || b.type === 'task') {
      list ??= [];
      list.push(
        b.type === 'task' ? (
          <li key={i} className="cv-task">
            <label onPointerDown={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={b.checked} disabled={!onToggle} onChange={() => onToggle?.(b.line)} aria-label={`${label}: ${b.runs.map((r) => r.text).join('')}`} />
              <span className={b.checked ? 'cv-done' : undefined}>
                <Runs runs={b.runs} />
              </span>
            </label>
          </li>
        ) : (
          <li key={i}>
            <Runs runs={b.runs} />
          </li>
        ),
      );
      return;
    }
    flush();
    // a card heading is a bold line, not a document heading (cards are not sections of the page)
    if (b.type === 'h')
      out.push(
        <p key={i} className={`cv-h cv-h${b.level}`}>
          <Runs runs={b.runs} />
        </p>,
      );
    else if (b.type === 'hr') out.push(<hr key={i} />);
    else
      out.push(
        <p key={i}>
          <Runs runs={b.runs} />
        </p>,
      );
  });
  flush();
  return out;
}

/** A textarea that takes focus when it appears and ends editing on Escape (Ctrl/Cmd+Enter too). */
function EditText({ value, onChange, onDone, label }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(ref.current.value.length, ref.current.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="cv-edit"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}

/** A one-line field for labels, names and addresses. */
function EditLine({ value, onChange, onDone, label, type = 'text' }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      type={type}
      className="cv-edit-line"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}

/**
 * The inside of one card.
 * @param {{ node: any, bookId: string, refInfo: any, editing: boolean, readOnly: boolean, onPatch: (fn: (n: any) => any, commit?: boolean) => void, onDone: () => void }} props
 *   `onPatch(fn, false)` changes the card while typing (no undo step); `onDone` ends editing (one undo step for the whole edit).
 */
export function CardBody({ node, bookId, refInfo, editing, readOnly, onPatch, onDone }) {
  const kind = nodeKind(node);
  if (kind === 'note' || kind === 'todo') {
    if (editing) return <EditText label={kind === 'todo' ? 'To-do list (one "- [ ]" line per item)' : 'Note text (Markdown)'} value={node.text} onChange={(text) => onPatch((n) => ({ ...n, text }), false)} onDone={onDone} />;
    const counts = kind === 'todo' ? taskCounts(node.text) : null;
    return (
      <div className="cv-md">
        {counts && counts.total > 0 && (
          <p className="cv-meta">
            {counts.done} of {counts.total} done
          </p>
        )}
        <MarkdownView text={node.text} onToggle={readOnly ? null : (line) => onPatch((n) => ({ ...n, text: toggleTask(n.text, line) }))} />
      </div>
    );
  }
  if (kind === 'swatch') {
    const { name, hex } = node.storyforge;
    const [r, g, b] = hexToRgb(hex);
    const setSwatch = (next, commit) => onPatch((n) => ({ ...n, color: next.hex, text: swatchText(next.name, next.hex), storyforge: { ...n.storyforge, ...next } }), commit);
    return (
      <div className="cv-swatch">
        <div className="cv-swatch-chip" style={{ background: hex, color: inkOn(hex) }} aria-hidden="true" />
        {editing ? (
          <div className="cv-swatch-edit">
            <EditLine label="Swatch name" value={name} onChange={(v) => setSwatch({ name: v, hex }, false)} onDone={onDone} />
            <input type="color" aria-label="Swatch colour" value={hex.toLowerCase()} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setSwatch({ name, hex: e.target.value.toUpperCase() }, false)} />
          </div>
        ) : (
          <div className="cv-swatch-text">
            <strong>{name}</strong>
            <span>Hex {hex.toUpperCase()}</span>
            <span>
              RGB ({r}, {g}, {b})
            </span>
          </div>
        )}
      </div>
    );
  }
  if (kind === 'image') return <img className="cv-img" src={assetUrl(bookId, node.file)} alt={node.file.split('/').pop()} draggable={false} />;
  if (kind === 'story') {
    const ok = refInfo?.state === 'ok';
    return (
      <div className={`cv-story cv-story-${refInfo?.state ?? 'broken'}`}>
        <p className="cv-meta">{ok ? REF_KIND_LABEL[refInfo.kind] ?? refInfo.kind : refInfo?.state === 'archived' ? `${REF_KIND_LABEL[refInfo.kind] ?? 'Item'} · archived` : 'Missing from the book'}</p>
        <p className="cv-story-title">{refInfo?.title ?? node.storyforge.ref}</p>
        {refInfo?.summary && <p className="cv-story-summary">{refInfo.summary}</p>}
        {ok && (
          <Link className="cv-open" to={storyHref(bookId, refInfo)} onPointerDown={(e) => e.stopPropagation()}>
            Open
          </Link>
        )}
      </div>
    );
  }
  if (kind === 'file')
    return (
      <div className="cv-story">
        <p className="cv-meta">File</p>
        <p className="cv-story-title">{node.file}</p>
      </div>
    );
  if (kind === 'link') {
    if (editing) return <EditLine label="Web address" value={node.url} onChange={(url) => onPatch((n) => ({ ...n, url }), false)} onDone={onDone} />;
    const href = safeUrl(node.url);
    return (
      <div className="cv-link">
        <p className="cv-meta">{hostOf(node.url)}</p>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" onPointerDown={(e) => e.stopPropagation()}>
            {node.url}
          </a>
        ) : (
          <span>{node.url}</span>
        )}
      </div>
    );
  }
  return null;
}

/** The label strip of a group or column (editable in place). */
export function ContainerHead({ node, editing, onPatch, onDone, count }) {
  const kind = nodeKind(node);
  const color = cssColor(node.color);
  return (
    <div className="cv-head" style={color ? { borderColor: color } : undefined}>
      {editing ? (
        <EditLine label={`${kind === 'column' ? 'Column' : 'Group'} name`} value={node.label ?? ''} onChange={(label) => onPatch((n) => ({ ...n, label }), false)} onDone={onDone} />
      ) : (
        <span className="cv-head-label">{node.label || (kind === 'column' ? 'Column' : 'Group')}</span>
      )}
      {kind === 'column' && <span className="cv-meta">{count}</span>}
    </div>
  );
}
