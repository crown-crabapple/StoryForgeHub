import { Link } from '../router.jsx';
import { UNSUPPORTED_LABELS, codePointText, problemGroups, sceneHref } from './requests.js';

/** "pages 4, 9 and 12" @param {number[]} pages */
const pagesText = (pages) => (pages.length === 0 ? '' : `${pages.length === 1 ? 'page' : 'pages'} ${pages.length > 1 ? `${pages.slice(0, -1).join(', ')} and ${pages.at(-1)}` : pages[0]}`);

/**
 * The Report panel: the page count, words, what the preview flattens or drops (with links to the scenes), the characters the font does not cover, and what the layout check found
 * on the pages (clipped text, stranded headings, widows and orphans to review, text that differs from the book), each with page numbers.
 * @param {{ bookId: string, report: any, summary: { state: string, pages: number, problems: { kind: string, page: number | null, message: string }[] } | null }} props
 *   `report` is the report of the snapshot; `summary` is what the preview page posted (null while it lays out).
 */
export function InteriorReport({ bookId, report, summary }) {
  const unsupported = Array.isArray(report?.unsupported) ? report.unsupported : [];
  const glyphs = Array.isArray(report?.missingGlyphs) ? report.missingGlyphs : [];
  const groups = summary?.state === 'done' ? problemGroups(summary.problems) : [];
  return (
    <section className="interior-report" aria-label="Report">
      <h2>Report</h2>
      <dl className="interior-facts">
        <div>
          <dt>Pages</dt>
          <dd>{summary?.state === 'done' ? summary.pages : 'Not laid out yet'}</dd>
        </div>
        <div>
          <dt>Words</dt>
          <dd>{report?.words ?? 0}</dd>
        </div>
        <div>
          <dt>Chapters</dt>
          <dd>{report?.chapters ?? 0}</dd>
        </div>
        <div>
          <dt>Scenes</dt>
          <dd>{report?.scenes ?? 0}</dd>
        </div>
      </dl>

      <h3>Content the preview does not lay out</h3>
      {unsupported.length === 0 ? (
        <p className="secondary">None found.</p>
      ) : (
        <>
          <p className="secondary">This version flattens or leaves out these kinds of Markdown. Your manuscript is not changed.</p>
          <ul className="interior-unsupported">
            {unsupported.map((u, i) => (
              <li key={`${u.kind}-${u.sceneId}-${i}`}>
                {UNSUPPORTED_LABELS[/** @type {keyof typeof UNSUPPORTED_LABELS} */ (u.kind)] ?? u.kind}: {u.count}{' '}
                {typeof u.sceneId === 'string' && u.sceneId !== '' && (
                  <Link className="btn btn-small" to={sceneHref(bookId, u.sceneId)}>
                    Open the scene
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Characters the font does not have</h3>
      {glyphs.length === 0 ? (
        <p className="secondary">None found.</p>
      ) : (
        <>
          <p className="secondary">These characters are not in the chosen font and show in a fallback font. This is judged from the character ranges the font declares, so it is an estimate.</p>
          <ul className="interior-glyphs">
            {glyphs.map((g) => (
              <li key={g.codePoint}>
                <span className="interior-glyph" lang="und">
                  {g.char}
                </span>{' '}
                <code>{codePointText(g.codePoint)}</code>, {g.count} {g.count === 1 ? 'time' : 'times'}
                {Array.isArray(g.sceneIds) && g.sceneIds.length > 0 && (
                  <>
                    {' '}
                    <Link className="btn btn-small" to={sceneHref(bookId, g.sceneIds[0])}>
                      Open the first scene
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Found on the laid-out pages</h3>
      {summary === null && <p className="secondary">Shown when the pages are laid out.</p>}
      {summary?.state === 'failed' && <p className="secondary">The pages could not be laid out, so they were not checked.</p>}
      {summary?.state === 'done' && groups.length === 0 && <p className="secondary">Nothing to review.</p>}
      {groups.map((g) => (
        <div key={g.key} className="interior-problems" data-problem={g.key}>
          <h4>{g.label}</h4>
          <p className="secondary">
            {g.note} {pagesText(g.pages) && <span>On {pagesText(g.pages)}.</span>}
          </p>
          {g.key === 'missingText' && (
            <ul>
              {g.items.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
