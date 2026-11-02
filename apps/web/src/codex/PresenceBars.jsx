import { barHeights, presenceByChapter, presenceSummary } from './model.js';

/**
 * "Presence by chapter": one bar per chapter, as tall as the scenes of that chapter where the entry appears. Explicit scenes are the solid
 * segment; scenes that only mention the entry are stacked on top, lighter. The group has a text alternative (`role="img"`).
 * @param {{ name: string, appearsIn: any[], chapters: { chapter: number, scene_ids?: string[] }[] }} props
 */
export function PresenceBars({ name, appearsIn, chapters }) {
  const bars = barHeights(presenceByChapter(appearsIn, chapters));
  return (
    <div className="presence" role="img" aria-label={presenceSummary(name, presenceByChapter(appearsIn, chapters))}>
      {bars.map((b) => (
        <div className="presence-col" key={b.chapter} data-chapter={b.chapter} data-explicit={b.explicit} data-inferred={b.inferred}>
          <div className="presence-bar" style={{ height: `${b.px}px` }}>
            {b.inferredPx > 0 && <div className="presence-inferred" style={{ height: `${b.inferredPx}px` }} />}
            {b.explicitPx > 0 && <div className="presence-explicit" style={{ height: `${b.explicitPx}px` }} />}
          </div>
          <span className="presence-label">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
