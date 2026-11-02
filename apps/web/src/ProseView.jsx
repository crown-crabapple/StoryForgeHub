import { segmentProse } from './prose.js';

/**
 * Read-only display of scene prose. HTML comments stay visible (dimmed, italic); [[slug|Label]] shows its
 * label with a dotted accent underline. The stored text is never changed: this only chooses how to show it.
 */
export function ProseView({ source }) {
  return (
    <div className="prose">
      {segmentProse(source).map((seg, i) => {
        switch (seg.type) {
          case 'comment':
            return (
              <span key={i} className="prose-comment">
                {seg.text}
              </span>
            );
          case 'wikilink':
            return (
              <span key={i} className="prose-link" title={seg.slug}>
                {seg.text}
              </span>
            );
          case 'code':
            return seg.block ? (
              <pre key={i} className="prose-code">
                {seg.text}
              </pre>
            ) : (
              <code key={i} className="prose-code-inline">
                {seg.text}
              </code>
            );
          default:
            return <span key={i}>{seg.text}</span>;
        }
      })}
    </div>
  );
}
