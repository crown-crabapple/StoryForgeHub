// The interactive board of one canvas (M09-J01): pan and zoom, select, drag, resize, connect, edit in place, and the Storyflow-style toolbar.
// It owns only what is on the screen (view, selection, the gesture in progress); the canvas document lives in CanvasView, which saves it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useModule } from '../prefs/PrefsContext.jsx';
import { RELATIONS, relationLabel } from '../planner/requests.js';
import { Dialog } from '../shell/Dialog.jsx';
import { useShortcuts } from '../shortcuts/ShortcutsContext.jsx';
import { CardBody, ContainerHead } from './CanvasCard.jsx';
import {
  KIND_LABEL,
  REF_KIND_LABEL,
  assetUrl,
  bounds,
  cardName,
  carried,
  columnMembers,
  connect,
  cssColor,
  duplicate,
  edgeGeometry,
  edgeView,
  fitView,
  isContainer,
  layoutColumns,
  makeNode,
  moveBy,
  nodeKind,
  patchEdge,
  patchNode,
  readingOrder,
  refOf,
  relationFromLabel,
  removeIds,
  reverseEdge,
  safeUrl,
  sceneEnds,
  snap,
  toWorld,
  withLink,
  withoutLink,
  zoomAt,
} from './model.js';
import { IMAGE_ACCEPT } from './requests.js';

/** The toolbar, in order: [tool, label]. Each tool's key is the registry command canvas.<tool>. */
export const TOOLS = [
  ['note', 'Note'],
  ['todo', 'To-do list'],
  ['swatch', 'Colour swatch'],
  ['image', 'Image'],
  ['story', 'Story card'],
  ['link', 'Web link'],
  ['column', 'Column'],
  ['group', 'Group'],
  ['connect', 'Connect two cards'],
];
const TOOL_GLYPH = { note: 'Aa', todo: '☑', swatch: '◐', image: '▣', story: '✦', link: '🔗', column: '▥', group: '▢', connect: '↗' };

/**
 * @param {{ bookId: string, doc: { nodes: any[], edges: any[] }, refs: Record<string, any>, targets: any[], readOnly: boolean, fitKey: string,
 *   onChange: (next: any, opts?: { commit?: boolean }) => void, onUndo: () => void, onRedo: () => void,
 *   onUploadImage: (file: File) => Promise<{ ok: true, path: string } | { ok: false, message: string }>, onProblem: (message: string | null) => void,
 *   links?: Map<string, any> | null, linkWrites?: ReturnType<typeof import('./useCanvasLinks.js').useCanvasLinks> | null }} props
 *   `links` are the live Flow links by slug (null until loaded); `linkWrites` makes a scene-to-scene connection a real Flow link.
 */
export function CanvasBoard({ bookId, doc, refs, targets, readOnly, fitKey, onChange, onUndo, onRedo, onUploadImage, onProblem, links = null, linkWrites = null }) {
  const shortcuts = useShortcuts(); // the canvas keys come from the shortcut registry (M07-J04), so they can be rebound
  const boardRef = useRef(null);
  const fileRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState(() => new Set());
  const [edgeSel, setEdgeSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tool, setTool] = useState('select');
  const [pending, setPending] = useState(null); // connect: the first card
  const [picker, setPicker] = useState(null); // story card picker: { at }
  const [linkAsk, setLinkAsk] = useState(null); // web link: { at }
  const [confirmDel, setConfirmDel] = useState(null); // deleting a linked connection: { id, link, from, to }
  const plannerOn = useModule('planner');
  const gesture = useRef(null);
  const docRef = useRef(doc);
  const viewRef = useRef(view);
  const adds = useRef(0);
  useEffect(() => {
    docRef.current = doc;
    viewRef.current = view;
  });

  const byId = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes]);
  const ordered = useMemo(() => readingOrder(doc.nodes), [doc.nodes]);
  const sceneRefs = useMemo(() => Object.fromEntries(doc.nodes.filter((n) => nodeKind(n) === 'story').map((n) => [n.id, refOf(n, refs, targets)])), [doc.nodes, refs, targets]);

  // fit the canvas into the board when another canvas opens
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setView(fitView(bounds(docRef.current.nodes), r.width, r.height));
    setSelected(new Set());
    setEditing(null);
    setEdgeSel(null);
  }, [fitKey]);

  const fit = useCallback(() => {
    const r = boardRef.current?.getBoundingClientRect();
    if (r) setView(fitView(bounds(docRef.current.nodes), r.width, r.height));
  }, []);
  const zoomBy = useCallback((factor) => {
    const r = boardRef.current?.getBoundingClientRect();
    if (r) setView((v) => zoomAt(v, factor, r.width / 2, r.height / 2));
  }, []);

  // wheel: zooms around the pointer; Shift+wheel pans (a listener of our own, so preventDefault works). A card being edited keeps its own scrolling.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (e.target.closest?.('textarea, .cv-edge-edit')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.shiftKey) setView((v) => ({ ...v, x: v.x - (e.deltaX || e.deltaY), y: v.y - (e.deltaX ? e.deltaY : 0) }));
      else {
        const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // lines -> pixels
        setView((v) => zoomAt(v, Math.exp(-step * 0.0015), e.clientX - r.left, e.clientY - r.top));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Where a new card goes: the middle of what is on screen, a little lower and right for each one added in a row. */
  const dropPoint = () => {
    const r = boardRef.current?.getBoundingClientRect() ?? { width: 800, height: 600 };
    const k = (adds.current++ % 6) * 24;
    return toWorld(viewRef.current, r.width / 2 + k, r.height / 2 + k);
  };

  const add = (node, { edit = false } = {}) => {
    onChange(layoutColumns({ ...docRef.current, nodes: [...docRef.current.nodes, node] }));
    setSelected(new Set([node.id]));
    setEdgeSel(null);
    if (edit) setEditing(node.id);
  };

  function pickTool(t) {
    if (readOnly) return;
    onProblem(null);
    setPending(null);
    if (t === 'connect') {
      setTool((cur) => (cur === 'connect' ? 'select' : 'connect'));
      return;
    }
    setTool('select');
    const at = dropPoint();
    if (t === 'image') fileRef.current?.click();
    else if (t === 'story') setPicker({ at });
    else if (t === 'link') setLinkAsk({ at, url: '' });
    else add(makeNode(t, at), { edit: t === 'note' || t === 'todo' || t === 'group' || t === 'column' });
  }

  async function onFile(file) {
    if (!file) return;
    const at = dropPoint();
    const r = await onUploadImage(file);
    if (!r.ok) return onProblem(r.message);
    const size = await imageSize(assetUrl(bookId, r.path));
    add(makeNode('image', at, { file: r.path, size }));
  }

  // ------------------------------------------------------------ gestures

  function onBoardPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    boardRef.current.focus({ preventScroll: true });
    if (!e.shiftKey) setSelected(new Set());
    setEdgeSel(null);
    setEditing(null);
    setPending(null);
    gesture.current = { kind: 'pan', x0: e.clientX, y0: e.clientY, view0: viewRef.current, moved: false };
    boardRef.current.setPointerCapture?.(e.pointerId);
  }

  function onCardPointerDown(e, node) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (editing === node.id) return;
    setEdgeSel(null);
    if (tool === 'connect' && !readOnly) {
      if (!pending) setPending(node.id);
      else {
        onChange(connect(docRef.current, pending, node.id));
        setPending(null);
        setTool('select');
      }
      return;
    }
    let sel = selected;
    if (e.shiftKey) {
      sel = new Set(selected);
      if (sel.has(node.id)) sel.delete(node.id);
      else sel.add(node.id);
    } else if (!selected.has(node.id)) sel = new Set([node.id]);
    setSelected(sel);
    if (editing && editing !== node.id) setEditing(null);
    if (readOnly) return;
    const ids = new Set(sel);
    for (const id of sel) {
      const n = byId.get(id);
      if (n && isContainer(n)) for (const c of carried(docRef.current.nodes, n)) ids.add(c.id);
    }
    gesture.current = { kind: 'move', x0: e.clientX, y0: e.clientY, ids, origin: docRef.current, moved: false };
    boardRef.current.setPointerCapture?.(e.pointerId);
  }

  function onResizePointerDown(e, node) {
    e.stopPropagation();
    if (readOnly) return;
    gesture.current = { kind: 'resize', x0: e.clientX, y0: e.clientY, id: node.id, w0: node.width, h0: node.height, origin: docRef.current, moved: false };
    boardRef.current.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    g.moved = true;
    const z = viewRef.current.zoom;
    if (g.kind === 'pan') setView({ ...g.view0, x: g.view0.x + dx, y: g.view0.y + dy });
    else if (g.kind === 'move') onChange(moveBy(g.origin, g.ids, snap(dx / z), snap(dy / z)), { commit: false });
    else if (g.kind === 'resize') onChange(patchNode(g.origin, g.id, (n) => ({ ...n, width: Math.max(80, snap(g.w0 + dx / z)), height: Math.max(48, snap(g.h0 + dy / z)) })), { commit: false });
  }

  function onPointerUp(e) {
    const g = gesture.current;
    gesture.current = null;
    boardRef.current?.releasePointerCapture?.(e.pointerId);
    if (!g || !g.moved || g.kind === 'pan') return;
    onChange(layoutColumns(docRef.current), { commit: true, base: g.origin });
  }

  // ------------------------------------------------------------ keys

  /** canvas.* commands (from the shortcut registry, so they can be rebound) and the fixed widget keys: arrows nudge, Backspace deletes, Escape clears. */
  function onKeyDown(e) {
    if (editing || e.target.closest?.('input, textarea, select, a, .cv-toolbar, .cv-zoom, .cv-edge-edit')) return;
    const command = shortcuts.commandFor(e.nativeEvent ?? e, 'canvas');
    const write = !readOnly;
    const del = () => {
      if (edgeSel) {
        removeEdge(edgeSel);
      } else if (selected.size > 0) {
        onChange(layoutColumns(removeIds(docRef.current, selected)));
        setSelected(new Set());
      }
    };
    const run = {
      'canvas.undo': () => onUndo(),
      'canvas.redo': () => onRedo(),
      'canvas.duplicate': () => {
        if (selected.size === 0 || !write) return;
        const r = duplicate(docRef.current, selected);
        onChange(r.canvas);
        setSelected(r.ids);
      },
      'canvas.delete': () => write && del(),
      'canvas.edit': () => write && selected.size === 1 && setEditing([...selected][0]),
      'canvas.fit': () => fit(),
      'canvas.zoomIn': () => zoomBy(1.2),
      'canvas.zoomOut': () => zoomBy(1 / 1.2),
    };
    const tool = command?.startsWith('canvas.') ? TOOLS.find(([t]) => `canvas.${t}` === command) : null;
    if (command && (run[command] || tool)) {
      e.preventDefault();
      if (run[command]) run[command]();
      else pickTool(tool[0]);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace' && write) {
      e.preventDefault();
      del();
      return;
    }
    if (e.key === 'Escape') {
      setSelected(new Set());
      setEdgeSel(null);
      setPending(null);
      setTool('select');
      return;
    }
    const step = e.shiftKey ? 40 : 8;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key] && selected.size > 0 && write) {
      e.preventDefault();
      onChange(layoutColumns(moveBy(docRef.current, selected, ...arrows[e.key])));
    }
  }

  // keep focus on the board's own cards: a card that receives focus (Tab) is the selection
  const onCardFocus = (node) => {
    if (!selected.has(node.id) && !gesture.current) setSelected(new Set([node.id]));
  };

  const patch = (id) => (fn, commit = true) => onChange(patchNode(docRef.current, id, fn), { commit });
  const doneEditing = () => {
    setEditing(null);
    onChange(layoutColumns(docRef.current), { commit: true });
    boardRef.current?.focus({ preventScroll: true });
  };

  const containers = ordered.filter(isContainer);
  const cards = ordered.filter((n) => !isContainer(n));
  const world = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` };
  const edgeEditing = edgeSel ? doc.edges.find((x) => x.id === edgeSel) : null;
  const edgeMid = edgeEditing && byId.get(edgeEditing.fromNode) && byId.get(edgeEditing.toNode) ? edgeGeometry(edgeEditing, byId.get(edgeEditing.fromNode), byId.get(edgeEditing.toNode)).mid : null;
  function onEdgeLabel(e) {
    const label = e.target.value;
    onChange(patchEdge(docRef.current, edgeSel, (x) => ({ ...x, label })), { commit: false });
  }
  function onEdgeBlur() {
    onChange(docRef.current, { commit: true });
  }
  function onEdgeKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.currentTarget.blur();
      setEdgeSel(null);
      boardRef.current?.focus({ preventScroll: true });
    }
  }
  function onEdgeSelectKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.currentTarget.blur();
      setEdgeSel(null);
      boardRef.current?.focus({ preventScroll: true });
    }
  }
  function onEdgeArrow() {
    onChange(patchEdge(docRef.current, edgeSel, (x) => ({ ...x, toEnd: (x.toEnd ?? 'arrow') === 'arrow' ? 'none' : 'arrow' })));
  }
  function onEdgeRemove() {
    removeEdge(edgeSel);
  }

  // ------------------------------------------------------------ Flow relations on a scene-to-scene connection

  const canRelate = !readOnly && plannerOn && linkWrites !== null;
  const edgeEnds = edgeEditing ? sceneEnds(edgeEditing, doc.nodes, sceneRefs) : null;
  const edgeInfo = edgeEditing ? edgeView(edgeEditing, links) : null;
  const showRelation = canRelate && edgeEnds !== null;
  const patchThis = (id, fn) => onChange(patchEdge(docRef.current, id, fn));

  /** The Relation select: None archives the link, another relation changes it, the first one creates it (or adopts the one Flow already has). */
  async function chooseRelation(id, relation) {
    const edge = docRef.current.edges.find((x) => x.id === id);
    const ends = edge ? sceneEnds(edge, docRef.current.nodes, sceneRefs) : null;
    if (!edge || !ends || !linkWrites) return;
    const view = edgeView(edge, links);
    if (relation === '') {
      if (!view.slug) return;
      if (view.link && !(await linkWrites.archive(view.link)).ok) return;
      patchThis(id, withoutLink);
    } else if (view.link) {
      if (view.link.relation === relation) return;
      if ((await linkWrites.setRelation(view.link, relation)).ok) patchThis(id, (x) => withLink(x, view.slug, relation));
    } else {
      const r = await linkWrites.create({ from: ends.from, to: ends.to, relation });
      if (r.ok) patchThis(id, (x) => withLink(x, r.slug, relation));
    }
  }
  async function reverseLinked(id) {
    const edge = docRef.current.edges.find((x) => x.id === id);
    const view = edge ? edgeView(edge, links) : null;
    if (!view?.link || !linkWrites) return;
    if ((await linkWrites.reverse(view.link)).ok) patchThis(id, reverseEdge);
  }
  /** Delete one connection. One that shows a live Flow link asks first whether the link goes too. */
  function removeEdge(id) {
    const edge = docRef.current.edges.find((x) => x.id === id);
    const view = edge ? edgeView(edge, links) : null;
    if (edge && view?.link && canRelate) {
      const name = (nodeId, fallback) => sceneRefs[nodeId]?.title || fallback;
      setConfirmDel({ id, link: view.link, from: name(edge.fromNode, view.link.from), to: name(edge.toNode, view.link.to) });
      return;
    }
    onChange(removeIds(docRef.current, new Set([id])));
    setEdgeSel(null);
  }
  async function answerDelete(archive) {
    const ask = confirmDel;
    setConfirmDel(null);
    if (!ask) return;
    if (archive && !(await linkWrites.archive(ask.link)).ok) return;
    onChange(removeIds(docRef.current, new Set([ask.id])));
    setEdgeSel(null);
  }

  const renderNode = (n) => {
    const kind = nodeKind(n);
    const refInfo = kind === 'story' ? refOf(n, refs, targets) : null;
    const isSel = selected.has(n.id);
    const color = cssColor(n.color);
    const cls = ['cv-node', `cv-${kind}`, isSel ? 'is-selected' : '', pending === n.id ? 'is-pending' : '', editing === n.id ? 'is-editing' : ''].filter(Boolean).join(' ');
    const style = { left: n.x, top: n.y, width: n.width, height: n.height, ...(color && kind !== 'swatch' ? { '--cv-tint': color } : {}) };
    return (
      <div
        key={n.id}
        className={cls}
        style={style}
        tabIndex={0}
        role="group"
        aria-label={cardName(n, refInfo)}
        aria-roledescription={KIND_LABEL[kind].toLowerCase()}
        data-id={n.id}
        onPointerDown={(e) => onCardPointerDown(e, n)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!readOnly && ['note', 'todo', 'swatch', 'link', 'group', 'column'].includes(kind)) setEditing(n.id);
        }}
        onFocus={() => onCardFocus(n)}
      >
        {isContainer(n) ? (
          <ContainerHead node={n} editing={editing === n.id} onPatch={patch(n.id)} onDone={doneEditing} count={kind === 'column' ? columnMembers(doc.nodes, n).length : 0} />
        ) : (
          <CardBody node={n} bookId={bookId} refInfo={refInfo} editing={editing === n.id} readOnly={readOnly} onPatch={patch(n.id)} onDone={doneEditing} />
        )}
        {isSel && !readOnly && selected.size === 1 && editing !== n.id && <span className="cv-resize" aria-hidden="true" onPointerDown={(e) => onResizePointerDown(e, n)} />}
      </div>
    );
  };

  return (
    <div className="cv-board-wrap">
      <div
        ref={boardRef}
        className={`cv-board${tool === 'connect' ? ' is-connecting' : ''}`}
        tabIndex={0}
        role="application"
        aria-roledescription="canvas"
        aria-label={`Canvas board, ${doc.nodes.length} cards. Tab moves between cards; Enter edits; arrow keys move; the toolbar keys add cards.`}
        onPointerDown={onBoardPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="cv-world" style={world}>
          <div className="cv-layer cv-layer-groups">{containers.map(renderNode)}</div>
          <svg className="cv-edges" aria-hidden="true" width="1" height="1" overflow="visible">
            <defs>
              <marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {doc.edges.map((ed) => {
              const a = byId.get(ed.fromNode);
              const b = byId.get(ed.toNode);
              if (!a || !b) return null;
              const g = edgeGeometry(ed, a, b);
              const color = cssColor(ed.color);
              const view = edgeView(ed, links);
              return (
                <g key={ed.id} className={['cv-edge', edgeSel === ed.id ? 'is-selected' : '', view.state === 'unlinked' ? 'is-unlinked' : ''].filter(Boolean).join(' ')} style={color ? { '--cv-edge': color } : undefined}>
                  <path
                    className="cv-edge-hit"
                    d={g.d}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected(new Set());
                      setEdgeSel(ed.id);
                      boardRef.current?.focus({ preventScroll: true });
                    }}
                  />
                  <path className="cv-edge-line" d={g.d} data-relation={view.link?.relation} data-style={view.group ?? undefined} strokeDasharray={view.dasharray ?? undefined} markerEnd={(ed.toEnd ?? 'arrow') === 'arrow' ? 'url(#cv-arrow)' : undefined} markerStart={ed.fromEnd === 'arrow' ? 'url(#cv-arrow)' : undefined} />
                  {view.label && edgeSel !== ed.id && (
                    <text className="cv-edge-label" x={g.mid.x} y={g.mid.y} textAnchor="middle" dominantBaseline="middle">
                      {view.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="cv-layer cv-layer-cards">{cards.map(renderNode)}</div>
          {edgeEditing && !readOnly && edgeMid && (
            <div className="cv-edge-edit" style={{ left: edgeMid.x, top: edgeMid.y }} onPointerDown={(e) => e.stopPropagation()}>
              {edgeInfo.state !== 'live' && !(showRelation && edgeInfo.slug) && (
                <input type="text" aria-label="Connection label" placeholder="Label" value={edgeEditing.label ?? ''} onChange={onEdgeLabel} onBlur={onEdgeBlur} onKeyDown={onEdgeKey} />
              )}
              {edgeInfo.state === 'live' && !showRelation && <span className="cv-edge-note">{`Flow: ${edgeInfo.label}`}</span>}
              {showRelation && (
                <select aria-label="Relation" value={edgeInfo.link?.relation ?? ''} onChange={(e) => chooseRelation(edgeEditing.id, e.target.value)} onKeyDown={onEdgeSelectKey}>
                  <option value="">None</option>
                  {RELATIONS.map((r) => (
                    <option key={r.value} value={r.value} title={r.description}>
                      {relationLabel(r.value)}
                    </option>
                  ))}
                </select>
              )}
              {edgeInfo.state === 'unlinked' && (
                <span className="cv-edge-note" role="status">
                  The Flow link is archived or gone
                </span>
              )}
              {showRelation && edgeInfo.state === 'unlinked' && relationFromLabel(edgeEditing.label) && (
                <button type="button" className="btn" onClick={() => chooseRelation(edgeEditing.id, relationFromLabel(edgeEditing.label))}>
                  Link again
                </button>
              )}
              {showRelation && edgeInfo.state === 'live' && (
                <button type="button" className="btn" onClick={() => reverseLinked(edgeEditing.id)}>
                  Reverse
                </button>
              )}
              <button type="button" className="btn" onClick={onEdgeArrow}>
                {(edgeEditing.toEnd ?? 'arrow') === 'arrow' ? 'No arrow' : 'Arrow'}
              </button>
              <button type="button" className="btn" onClick={onEdgeRemove}>
                Remove
              </button>
            </div>
          )}
        </div>
        {doc.nodes.length === 0 && (
          <div className="cv-hint" aria-hidden="true">
            <p>An empty canvas.</p>
            <p>Add a note, an image, a colour swatch or a card for a character or scene from the toolbar below.</p>
          </div>
        )}
        {tool === 'connect' && (
          <p className="cv-mode" role="status">
            {pending ? 'Now choose the card to connect to.' : 'Choose the card to connect from.'} Escape cancels.
          </p>
        )}
      </div>

      <div className="cv-zoom" role="group" aria-label="Zoom">
        <button type="button" className="cv-tool" onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in (=)">
          +
        </button>
        <span className="cv-zoom-value" aria-live="polite">
          {Math.round(view.zoom * 100)}%
        </span>
        <button type="button" className="cv-tool" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out (-)">
          −
        </button>
        <button type="button" className="cv-tool" onClick={fit} aria-label="Fit everything" title="Fit (F)">
          ⤢
        </button>
        <button type="button" className="cv-tool" onClick={onUndo} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={readOnly}>
          ↶
        </button>
        <button type="button" className="cv-tool" onClick={onRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={readOnly}>
          ↷
        </button>
      </div>

      {!readOnly && (
        <div className="cv-toolbar" role="toolbar" aria-label="Add to the canvas">
          {TOOLS.map(([t, label]) => {
            const key = shortcuts.bindings?.[`canvas.${t}`] ?? null;
            return (
            <button
              key={t}
              type="button"
              className="cv-tool"
              aria-label={label}
              aria-keyshortcuts={key ?? undefined}
              aria-pressed={t === 'connect' ? tool === 'connect' : undefined}
              title={key ? `${label} (${key})` : label}
              onClick={() => pickTool(t)}
            >
              <span aria-hidden="true">{TOOL_GLYPH[t]}</span>
            </button>
            );
          })}
          <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            onFile(f);
          }} />
        </div>
      )}

      {picker && (
        <StoryPicker
          targets={targets}
          onClose={() => setPicker(null)}
          onPick={(t) => {
            add(makeNode('story', picker.at, { ref: t.ref }));
            setPicker(null);
          }}
        />
      )}
      {confirmDel && (
        <Dialog label="Delete the connection" onClose={() => setConfirmDel(null)}>
          <h2>Delete the connection</h2>
          <p>{`Also archive the Flow link ${confirmDel.from} → ${confirmDel.to}?`}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirmDel(null)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => answerDelete(false)}>
              Keep the link
            </button>
            <button type="button" className="btn btn-primary" onClick={() => answerDelete(true)}>
              Archive link too
            </button>
          </div>
        </Dialog>
      )}
      {linkAsk && (
        <LinkDialog
          onClose={() => setLinkAsk(null)}
          onAdd={(url) => {
            add(makeNode('link', linkAsk.at, { url }));
            setLinkAsk(null);
          }}
        />
      )}
    </div>
  );
}

/** The natural size of an image, scaled to at most 320 px wide (280 x 200 when it cannot be loaded). @param {string} src */
function imageSize(src) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve([280, 200]);
    const img = new Image();
    img.onload = () => {
      const w = Math.min(320, img.naturalWidth || 280);
      resolve([snap(w), snap(Math.max(48, (w * (img.naturalHeight || 200)) / (img.naturalWidth || 280)))]);
    };
    img.onerror = () => resolve([280, 200]);
    img.src = src;
  });
}

/** Choose a scene, Codex entry, thread, event or note for a story card. */
export function StoryPicker({ targets, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const kinds = [...new Set(targets.map((t) => t.kind))];
  const needle = q.trim().toLowerCase();
  const shown = targets.filter((t) => (kind === 'all' || t.kind === kind) && (needle === '' || `${t.title} ${t.subtitle}`.toLowerCase().includes(needle))).slice(0, 200);
  return (
    <Dialog label="Add a story card" onClose={onClose} className="cv-picker">
      <h2>Add a story card</h2>
      <p className="muted">The card stays linked to the book: it follows a scene that moves and opens the real thing.</p>
      <div className="cv-picker-filters">
        <label className="sr-only" htmlFor="cv-picker-q">
          Find
        </label>
        <input id="cv-picker-q" type="search" placeholder="Find a scene, character, place, thread…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <div role="group" aria-label="Kind" className="cv-picker-kinds">
          {['all', ...kinds].map((k) => (
            <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : REF_KIND_LABEL[k] ?? k}
            </button>
          ))}
        </div>
      </div>
      <ul className="cv-picker-list">
        {shown.map((t) => (
          <li key={t.ref}>
            <button type="button" onClick={() => onPick(t)}>
              <span className="cv-meta">{REF_KIND_LABEL[t.kind] ?? t.kind}</span>
              <span className="cv-picker-title">{t.title}</span>
              <span className="muted">{t.subtitle}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">Nothing matches.</li>}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** Ask for a web address (http, https or mailto). */
function LinkDialog({ onAdd, onClose }) {
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState(null);
  return (
    <Dialog label="Add a web link" onClose={onClose}>
      <h2>Add a web link</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const ok = safeUrl(url);
          if (!ok) return setProblem('Give a full web address that starts with http, https or mailto.');
          return onAdd(ok);
        }}
      >
        <div className="form-row">
          <label>
            <span className="form-label">Web address</span>
            <input type="url" name="url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" aria-invalid={problem ? 'true' : undefined} />
          </label>
          <p className="muted form-hint">The link opens in a new tab. Nothing is fetched from it.</p>
          {problem && (
            <p className="error" role="alert">
              {problem}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Add link
          </button>
        </div>
      </form>
    </Dialog>
  );
}
