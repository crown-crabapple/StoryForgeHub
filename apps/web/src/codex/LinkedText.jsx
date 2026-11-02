import { Link } from '../router.jsx';
import { segmentProse } from '../prose.js';
import { codexHref } from './model.js';

/**
 * A short text (a field value) with its [[links]] shown as labels: a link that names an entry of the book opens that entry in the Codex.
 * A link without a label of its own shows the entry's name.
 * @param {{ text: string, bookId: string, resolve?: (ref: string) => { id: string, name?: string | null } | null }} props
 */
export function LinkedText({ text, bookId, resolve }) {
  return (
    <>
      {segmentProse(String(text)).map((seg, i) => {
        if (seg.type !== 'wikilink') return <span key={i}>{seg.text}</span>;
        const target = resolve?.(seg.slug) ?? null;
        return target ? (
          <Link key={i} to={codexHref(bookId, { entry: target.id })} className="codex-link" title={seg.slug}>
            {seg.label === seg.slug && target.name ? target.name : seg.text}
          </Link>
        ) : (
          <span key={i} className="prose-link" title={seg.slug}>
            {seg.text}
          </span>
        );
      })}
    </>
  );
}
