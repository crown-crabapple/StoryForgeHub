import { useMemo } from 'react';
import { saveBlob } from '../export/requests.js';
import { planHref } from './requests.js';
import { relationshipLayout, relationshipSvg } from './relgraph.js';

/**
 * The relationship graph of the Lanes view: each entry that is on an end of a relationship is a circle, each relationship a line between its two entries, labelled with how it ends (or starts,
 * or its name). Entries and lines can be reached with Tab; Enter on a line opens that relationship (each line is a link). "Download SVG" saves the picture as a file. Presentational.
 * @param {{ bookId: string, relationships: any[], selectedSlug?: string | null, bookSlug?: string | null, onSelect?: (slug: string) => void }} props
 */
export function RelationshipGraph({ bookId, relationships, selectedSlug = null, bookSlug = null, onSelect }) {
  const layout = useMemo(() => relationshipLayout(relationships), [relationships]);
  if (relationships.length === 0) return <p>No relationships yet.</p>;
  const download = () => saveBlob(new Blob([relationshipSvg(layout)], { type: 'image/svg+xml' }), `${bookSlug || 'book'}-relationships.svg`);
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  return (
    <div className="rel-graph">
      <p>
        <button type="button" className="btn" onClick={download}>
          Download SVG
        </button>
      </p>
      <svg className="rel-graph-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="group" aria-label="Relationship graph. The List view has the same relationships.">
        {layout.edges.map((e) => {
          const name = `Relationship ${e.name || e.slug}: ${at.get(e.from)?.name} and ${at.get(e.to)?.name}${e.label && e.label !== e.name ? `, ${e.label}` : ''}. Press Enter to open it.`;
          return (
            <a
              key={e.slug}
              className={`rel-edge${e.slug === selectedSlug ? ' rel-edge-selected' : ''}`}
              href={planHref(bookId, { view: 'arcs', mode: 'relationships', relationship: e.slug })}
              aria-label={name}
              aria-current={e.slug === selectedSlug ? 'true' : undefined}
              onClick={(ev) => {
                ev.preventDefault();
                onSelect?.(e.slug);
              }}
            >
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="currentColor" strokeWidth={e.slug === selectedSlug ? 4 : 2} opacity="0.7" />
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="transparent" strokeWidth="14" />
              {e.label && (
                <text x={e.mx} y={e.my} textAnchor="middle" fontSize="12" fill="currentColor" stroke="Canvas" strokeWidth="3" paintOrder="stroke">
                  {e.label}
                </text>
              )}
            </a>
          );
        })}
        {layout.nodes.map((n) => (
          <g key={n.id} className="rel-node" tabIndex={0} role="img" aria-label={`Entry ${n.name}`}>
            <circle cx={n.x} cy={n.y} r={n.r} fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="2" />
            <text x={n.x} y={n.y + n.r + 16} textAnchor="middle" fontSize="14" fill="currentColor">
              {n.name}
            </text>
          </g>
        ))}
      </svg>
      <p className="muted">The List view has the same relationships and their developments.</p>
    </div>
  );
}
