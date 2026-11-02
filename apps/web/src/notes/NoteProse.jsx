import { segmentProse } from '../prose.js';
import { ExternalLinkIcon } from '../shell/icons.jsx';
import { inlineParts } from './render.js';

/** One Markdown link, image or citation of a note, drawn by the rules of render.js. */
function Part({ part, sources }) {
  if (part.type === 'text') return <span>{part.text}</span>;
  if (part.type === 'cite') {
    const title = sources?.get(part.key);
    return (
      <span className="note-cite" title={title ?? 'Source not found'} data-missing={title === undefined ? 'true' : undefined}>
        {part.raw}
      </span>
    );
  }
  const { target } = part;
  if (part.type === 'image') {
    return target.kind === 'attachment' && target.image ? (
      <img className="note-image" src={target.url} alt={part.label} loading="lazy" />
    ) : (
      <span className="note-plain" title="This image cannot be shown">{part.label || 'image'}</span>
    );
  }
  if (target.kind === 'external') {
    // opens in a new tab and is never followed by the app; the host shows where it goes
    return (
      <a className="note-link note-external" href={target.url} target="_blank" rel="noopener noreferrer">
        {part.label || target.host}
        <ExternalLinkIcon className="note-ext-icon" />
        <span className="note-host">{target.host}</span>
      </a>
    );
  }
  if (target.kind === 'attachment') {
    return (
      <a className="note-link note-attachment" href={target.url} target="_blank" rel="noopener noreferrer" title={target.path}>
        {part.label || target.path}
      </a>
    );
  }
  return <span className="note-plain">{part.label}</span>;
}

/**
 * A note's text for reading: the same display rules as the editor's reading view (author notes stay visible and dimmed, [[links]] show their label), with Markdown
 * links drawn by render.js (external links in a new tab with the host; attachment links open the attachment route), `[@cite]` as a citation chip, and images
 * from assets/ shown. The stored text is never changed.
 * @param {{ source: string, notePath: string, bookId: string, sources?: Map<string, string> }} props `notePath`: the note's path relative to the book root; `sources`: cite key -> title
 */
export function NoteProse({ source, notePath, bookId, sources }) {
  return (
    <div className="prose note-prose">
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
            return inlineParts(seg.text, notePath, bookId).map((part, j) => <Part key={`${i}-${j}`} part={part} sources={sources} />);
        }
      })}
    </div>
  );
}
