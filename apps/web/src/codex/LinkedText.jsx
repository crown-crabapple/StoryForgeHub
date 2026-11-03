import { Link } from '../router.jsx';
import { segmentProse } from '../prose.js';
import { codexHref } from './model.js';

/**
 * A short text (a field value) with its [[links]] shown as labels: a link that names an entry of the book opens that entry in the Codex.
 * A link without a label of its own shows the entry's name. `linkOf(ref)` (M07-J01b) answers for the links `resolve` does not know, the cross-book ones
 * `[[book-slug:slug]]`: { href, name } opens the other book on that entry.
 * @param {{ text: string, bookId: string, resolve?: (ref: string) => { id: string, name?: string | null } | null, linkOf?: (ref: string) => { href: string, name?: string | null } | null }} props
 */
export function LinkedText({ text, bookId, resolve, linkOf }) {
  return (
    <>
      {segmentProse(String(text)).map((seg, i) => {
        if (seg.type !== 'wikilink') return <span key={i}>{seg.text}</span>;
        const target = resolve?.(seg.slug) ?? null;
        const cross = target ? null : (linkOf?.(seg.slug) ?? null);
        const href = target ? codexHref(bookId, { entry: target.id }) : (cross?.href ?? null);
        const name = target?.name ?? cross?.name ?? null;
        return href ? (
          <Link key={i} to={href} className="codex-link" title={seg.slug}>
            {seg.label === seg.slug && name ? name : seg.text}
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
