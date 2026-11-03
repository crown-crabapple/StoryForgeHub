import { Link } from './router.jsx';
import { segmentProse } from './prose.js';

/**
 * Read-only display of scene prose. HTML comments stay visible (dimmed, italic); [[slug|Label]] shows its
 * label with a dotted accent underline. The stored text is never changed: this only chooses how to show it.
 * `linkOf(ref)` (optional) makes the links it knows (a link into another book, M07-J01b) real links: { href, name }.
 */
export function ProseView({ source, linkOf }) {
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
          case 'wikilink': {
            const to = linkOf?.(seg.slug) ?? null;
            return to ? (
              <Link key={i} to={to.href} className="prose-link codex-link" title={seg.slug}>
                {seg.text}
              </Link>
            ) : (
              <span key={i} className="prose-link" title={seg.slug}>
                {seg.text}
              </span>
            );
          }
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
