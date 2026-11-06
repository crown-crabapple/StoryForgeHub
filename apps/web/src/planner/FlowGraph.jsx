import { useMemo, useRef, useState } from 'react';
import { clampZoom, edgeGeometry } from '../canvas/model.js';
import { PAD, describeLink, fitScale, layoutGraph, relationStroke, sceneName, strokeLegend } from './model.js';
import { relationLabel } from './requests.js';

const ZOOM_STEP = 1.25;

/**
 * The Flow graph: one column per chapter, scenes stacked by sequence, links as arrows. A second view of the same links as the list: every scene is a button, and every
 * line has a text label that is a button too, so the graph can be walked by keyboard. Lines are drawn dashed, dotted and so on by relation, and always named in words.
 * The links to a scene that is not in the book are not drawn (they stay in the list). Positions come only from the manuscript order (see layoutGraph); nothing moves.
 * @param {{ nodes: any[], edges: any[], nodeById?: Map<string, any>, selectedNode?: string | null, selectedLink?: string | null, scale?: number,
 *   onSelectNode?: (id: string) => void, onSelectEdge?: (slug: string) => void }} props
 *   `nodes` are the scenes to draw (GET /flow nodes, filtered), `edges` the live links (GET /flow edges); an edge is drawn when both ends are among `nodes`.
 */
export function FlowGraph({ nodes, edges, nodeById, selectedNode = null, selectedLink = null, scale: initialScale = 1, onSelectNode, onSelectEdge }) {
  const [scale, setScale] = useState(initialScale);
  const scroller = useRef(null);
  const layout = useMemo(() => layoutGraph(nodes), [nodes]);
  const boxes = useMemo(() => new Map(layout.nodes.map((b) => [b.id, b])), [layout]);
  const titles = useMemo(() => nodeById ?? new Map(nodes.map((n) => [n.id, n])), [nodeById, nodes]);
  const drawn = edges
    .filter((e) => !e.broken && boxes.has(e.from) && boxes.has(e.to))
    .map((e) => ({ edge: e, geo: edgeGeometry(e, boxes.get(e.from), boxes.get(e.to)), stroke: relationStroke(e.relation), name: describeLink(e, titles).name }));
  const missing = edges.filter((e) => e.broken).length;
  const fit = () => {
    const el = scroller.current;
    if (!el) return;
    setScale(fitScale(layout.width, layout.height, el.clientWidth, el.clientHeight));
    el.scrollTo?.(0, 0);
  };

  return (
    <div className="flow-graph" role="group" aria-label="Flow graph. The same links are in the List view.">
      <div className="flow-zoom">
        <button type="button" className="btn btn-small" onClick={() => setScale((s) => clampZoom(s / ZOOM_STEP))}>
          Zoom out
        </button>
        <button type="button" className="btn btn-small" onClick={() => setScale((s) => clampZoom(s * ZOOM_STEP))}>
          Zoom in
        </button>
        <button type="button" className="btn btn-small" onClick={fit}>
          Fit
        </button>
        <span className="muted" role="status">{`${Math.round(scale * 100)}%`}</span>
      </div>
      <div className="flow-scroll" ref={scroller}>
        <div className="flow-sizer" style={{ width: layout.width * scale, height: layout.height * scale }}>
          <div className="flow-layer" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}>
            <svg className="flow-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">
              <defs>
                <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {drawn.map(({ edge, geo, stroke }) => (
                <path
                  key={edge.id}
                  className="flow-edge"
                  data-style={stroke.group}
                  data-selected={edge.slug === selectedLink ? 'true' : undefined}
                  d={geo.d}
                  fill="none"
                  strokeDasharray={stroke.dasharray ?? undefined}
                  markerEnd="url(#flow-arrow)"
                />
              ))}
            </svg>
            {layout.columns.map((c) => (
              <div key={c.key} className="flow-col-head" style={{ left: c.x, top: PAD }} aria-hidden="true">
                {c.label}
              </div>
            ))}
            {layout.nodes.map((b) => {
              const n = titles.get(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  className="flow-node"
                  style={{ left: b.x, top: b.y, width: b.width, height: b.height }}
                  aria-pressed={b.id === selectedNode}
                  onClick={() => onSelectNode?.(b.id)}
                >
                  <span className="flow-node-title">{sceneName(n?.title)}</span>
                  <span className="flow-node-status">{n?.status ?? ''}</span>
                  <span className="flow-node-summary">{n?.summary ?? ''}</span>
                </button>
              );
            })}
            {drawn.map(({ edge, geo, stroke, name }) => (
              <button
                key={edge.id}
                type="button"
                className="flow-edge-label"
                data-style={stroke.group}
                style={{ left: geo.mid.x, top: geo.mid.y }}
                aria-label={name}
                aria-pressed={edge.slug === selectedLink}
                onClick={() => onSelectEdge?.(edge.slug)}
              >
                {relationLabel(edge.relation)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ul className="flow-legend muted" aria-label="Line styles">
        {strokeLegend().map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {missing > 0 && <p className="muted">{`Links to a missing scene are not drawn (${missing}). They are in the List view.`}</p>}
    </div>
  );
}

