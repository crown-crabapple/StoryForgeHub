import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { bodyLineOf, frontMatterLines, sourceHref, sourceLabel, splitEvidence } from './model.js';
import { RAW_URL, contextUrl } from './requests.js';

/**
 * Where "Open" goes for a source. A scene opens in the editor at the right line of its text: the file line is turned into a body line from the file's front matter,
 * read when the link is used. Other sources are plain links. `onBefore(source)` may take the click over (the rail selects the range in the open editor).
 * @param {{ bookId: string, source: any, onBefore?: (source: any, e: any) => boolean | void, className?: string, children: import('react').ReactNode }} props
 */
export function SourceLink({ bookId, source, onBefore, className, children }) {
  const navigate = useNavigate();
  return (
    <Link
      to={sourceHref(bookId, source)}
      className={className}
      onClick={async (e) => {
        if (source.kind !== 'scene') return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (onBefore?.(source, e) === true) return;
        let line = null;
        try {
          const res = await fetch(RAW_URL(bookId, source.file), { headers: { accept: 'application/json' } });
          if (res.ok) line = bodyLineOf(source.line, frontMatterLines((await res.json()).body ?? ''));
        } catch {
          // no line: the scene still opens
        }
        navigate(sourceHref(bookId, source, line));
      }}
    >
      {children}
    </Link>
  );
}

/** One line of context; the evidence line is marked, and inside it the evidence range. */
function ContextLine({ line, evidence, range }) {
  const here = line.n === evidence;
  const parts = here ? splitEvidence(line.text, range) : null;
  return (
    <li className={here ? 'cf-line cf-line-evidence' : 'cf-line'} aria-current={here ? 'true' : undefined}>
      <span className="cf-line-n">{line.n}</span>
      <span className="cf-line-text">
        {parts ? (
          <>
            {parts.before}
            {parts.mark !== '' ? <mark className="cf-evidence">{parts.mark}</mark> : null}
            {parts.after}
          </>
        ) : (
          line.text
        )}
      </span>
    </li>
  );
}

/**
 * One source: its heading, file and line, and the lines around the evidence (read from the file, ±3). Read-only.
 * `context` is the answer of GET /continuity/context (null while it loads, `false` when the file cannot be read).
 * @param {{ bookId: string, source: any, context: { lines: { n: number, text: string }[] } | null | false, withOpen?: boolean }} props
 */
export function SourcePanel({ bookId, source, context, withOpen = false }) {
  return (
    <section className="cf-panel" aria-label={`${source.role}: ${source.heading}`}>
      <header>
        <h3>{source.heading}</h3>
        <p className="muted cf-panel-where">
          <code>{source.file}</code> · line {source.line}
        </p>
      </header>
      {context === null ? (
        <p className="muted">Loading…</p>
      ) : context === false ? (
        <p className="muted">These lines cannot be read right now.</p>
      ) : (
        <ol className="cf-lines" aria-label="Lines around the evidence">
          {context.lines.map((l) => (
            <ContextLine key={l.n} line={l} evidence={source.line} range={source.range} />
          ))}
        </ol>
      )}
      {withOpen && (
        <p>
          <SourceLink bookId={bookId} source={source} className="btn">
            Open
          </SourceLink>
        </p>
      )}
    </section>
  );
}

/** Fetches the context of one source and draws the panel. */
function LoadedPanel({ bookId, source, version, withOpen }) {
  const { data, error, loading } = useApi(contextUrl(bookId, source), version);
  const context = loading ? null : error || !data ? false : data;
  return <SourcePanel bookId={bookId} source={source} context={context} withOpen={withOpen} />;
}

/**
 * "Show both": side by side, one panel per source (stacked when narrow: always in the rail, under 900 px in the queue).
 * @param {{ bookId: string, finding: { sources: any[] }, version?: string, withOpen?: boolean, stacked?: boolean }} props
 */
export function ShowBoth({ bookId, finding, version = '', withOpen = false, stacked = false }) {
  return (
    <div className={stacked ? 'cf-both cf-both-stacked' : 'cf-both'}>
      {finding.sources.map((s, i) => (
        <LoadedPanel key={`${s.file}|${s.line}|${i}`} bookId={bookId} source={s} version={version} withOpen={withOpen} />
      ))}
    </div>
  );
}

export { sourceLabel };
