// The Style checks page (M13-J03 section 9), presentational: the off state, the scope picker, Run, progress with Cancel, the results grouped by rule or chapter, the Dismissed list
// and the No longer matching list. The view (StyleChecksView.jsx) owns the data and the requests. Advice only: nothing here changes text except a replacement the author presses.
import { Link } from '../router.jsx';
import { ResultCard } from './ResultCard.jsx';
import { groupFindings, plural, progressText, ruleLabel, styleHref } from './model.js';

/** The notices a scan can leave: errors per scene and the findings cap. @param {{ scan: any, chapters: Record<string, any> | undefined }} props */
function ScanNotices({ scan, chapters }) {
  const errors = Array.isArray(scan.errors) ? scan.errors : [];
  return (
    <>
      {errors.length > 0 && (
        <div role="alert" className="form-error st-errors">
          <p>{plural(errors.length, 'problem')} while checking:</p>
          <ul>
            {errors.map((e, i) => (
              <li key={`${e.sceneId ?? 'book'}|${i}`}>
                {e.sceneId ? `${chapters?.[e.sceneId]?.title || 'A scene'}: ` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {scan.truncated === true && <p className="muted">Only the first 20,000 suggestions are kept. Check a smaller part of the book to see the rest.</p>}
    </>
  );
}

/** A dismissal in a list. @param {{ d: any, action: string, onAction: (slug: string) => void }} props */
function DismissalItem({ d, action, onAction }) {
  return (
    <li className="st-dismissal">
      <span>
        <strong>{`“${d.text}”`}</strong> · {ruleLabel(d.rule)}
        {d.note ? ` · ${d.note}` : ''}
      </span>{' '}
      <button type="button" className="btn btn-small" aria-label={`${action} the dismissal of “${d.text}”`} onClick={() => onAction(d.slug)}>
        {action}
      </button>
    </li>
  );
}

/**
 * @param {{
 *   bookId: string,
 *   loading?: boolean,
 *   enabled: boolean,
 *   chapters: { key: string, act: number, chapter: number, label: string, scenes: { id: string, title: string }[] }[],
 *   scope: { kind: 'manuscript' | 'chapter' | 'scenes', chapterKey: string | null, ids: string[] },
 *   canRun: boolean, starting?: boolean, startError?: string | null,
 *   scan: any | null, scanGone?: boolean,
 *   group: 'rule' | 'chapter',
 *   cards?: Record<string, { phase: 'idle' | 'busy' | 'applied' | 'dismissed', replacement?: string, error?: string | null }>,
 *   changedScenes?: string[],
 *   dismissals: any[] | null,
 *   notice?: string | null,
 *   handlers?: {
 *     onScopeKind?: (kind: string) => void, onChapter?: (key: string) => void, onToggleScene?: (id: string) => void, onRun?: () => void, onCancel?: () => void,
 *     onApply?: (f: any, index: number) => void, onUndo?: (f: any) => void, onDismiss?: (f: any, note: string) => void, onRestore?: (slug: string) => void, onRemove?: (slug: string) => void,
 *   },
 * }} props
 */
export function StyleChecksPage({
  bookId,
  loading = false,
  enabled,
  chapters,
  scope,
  canRun,
  starting = false,
  startError = null,
  scan,
  scanGone = false,
  group,
  cards = {},
  changedScenes = [],
  dismissals,
  notice = null,
  handlers = {},
}) {
  const noop = () => {};
  const { onScopeKind = noop, onChapter = noop, onToggleScene = noop, onRun = noop, onCancel = noop, onApply = noop, onUndo = noop, onDismiss = noop, onRestore = noop, onRemove = noop } = handlers;
  if (loading) {
    return (
      <main id="main" tabIndex={-1} className="page muted">
        Loading…
      </main>
    );
  }
  if (!enabled) {
    return (
      <main id="main" tabIndex={-1} className="page st-page">
        <h1>Style checks</h1>
        <p>
          Style checks are off for this book. Turn them on in <Link to="/settings">Settings</Link>.
        </p>
      </main>
    );
  }

  const running = scan?.state === 'running';
  const visible = (scan?.findings ?? []).filter((f) => cards[f.id]?.phase !== 'dismissed');
  const groups = groupFindings(visible, scan?.chapters, group);
  const stale = new Set(scan?.staleDismissals ?? []);
  const kept = (dismissals ?? []).filter((d) => !stale.has(d.slug));
  const gone = (dismissals ?? []).filter((d) => stale.has(d.slug));
  const scenesChecked = scan ? scan.total : 0;
  const finished = scan && scan.state !== 'running';

  return (
    <main id="main" tabIndex={-1} className="page st-page">
      <h1>Style checks</h1>
      <p className="muted">
        Style checks give advice about terms, repeated words, punctuation and rhythm. They run on this computer and never change your text unless you choose a replacement.
      </p>

      <section aria-labelledby="st-scope-heading" className="st-scope">
        <h2 id="st-scope-heading">What to check</h2>
        <fieldset disabled={running || starting}>
          <legend>Part of the book</legend>
          <div className="field">
            <label>
              <input type="radio" name="st-scope" value="manuscript" checked={scope.kind === 'manuscript'} onChange={() => onScopeKind('manuscript')} /> Whole manuscript
            </label>
          </div>
          <div className="field">
            <label>
              <input type="radio" name="st-scope" value="chapter" checked={scope.kind === 'chapter'} onChange={() => onScopeKind('chapter')} /> One chapter
            </label>
            {scope.kind === 'chapter' && (
              <div className="field">
                <label htmlFor="st-chapter">Chapter</label>
                <select id="st-chapter" value={scope.chapterKey ?? ''} onChange={(e) => onChapter(e.target.value)}>
                  <option value="">Choose a chapter</option>
                  {chapters.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="field">
            <label>
              <input type="radio" name="st-scope" value="scenes" checked={scope.kind === 'scenes'} onChange={() => onScopeKind('scenes')} /> Chosen scenes
            </label>
            {scope.kind === 'scenes' &&
              chapters.map((c) => (
                <fieldset key={c.key} className="st-scenes">
                  <legend>{c.label}</legend>
                  {c.scenes.length === 0 && <p className="muted">No scenes.</p>}
                  {c.scenes.map((s) => (
                    <div key={s.id} className="field">
                      <label>
                        <input type="checkbox" checked={scope.ids.includes(s.id)} onChange={() => onToggleScene(s.id)} /> {s.title}
                      </label>
                    </div>
                  ))}
                </fieldset>
              ))}
          </div>
        </fieldset>
        <p>
          <button type="button" className="btn btn-primary" disabled={!canRun || running || starting} onClick={onRun}>
            Run
          </button>
        </p>
        {startError && (
          <p role="alert" className="form-error">
            {startError}
          </p>
        )}
      </section>

      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}

      {starting && !scan && <p className="muted">Starting…</p>}
      {scanGone && <p className="muted">This scan is no longer kept by the server. Run it again.</p>}

      {scan && (
        <section aria-labelledby="st-results-heading" className="st-results">
          <h2 id="st-results-heading">Results</h2>
          {running && (
            <div className="st-progress">
              <div
                className="st-bar"
                role="progressbar"
                aria-label="Style scan progress"
                aria-valuemin={0}
                aria-valuemax={scan.total}
                aria-valuenow={scan.done}
                aria-valuetext={progressText(scan.done, scan.total)}
              >
                <span className="st-bar-fill" style={{ width: `${scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0}%` }} />
              </div>
              <p aria-live="polite" role="status">
                {progressText(scan.done, scan.total)}
              </p>
              <p>
                <button type="button" className="btn" onClick={onCancel}>
                  Cancel
                </button>
              </p>
            </div>
          )}
          {scan.state === 'failed' && (
            <p role="alert" className="form-error">
              The scan could not finish. {scan.done > 0 ? `${progressText(scan.done, scan.total)} were checked.` : ''}
            </p>
          )}
          {scan.state === 'cancelled' && (
            <p role="status" className="muted">
              The scan was cancelled after {progressText(scan.done, scan.total)}. What it found so far is below.
            </p>
          )}
          <ScanNotices scan={scan} chapters={scan.chapters} />
          {finished && (
            <p aria-live="polite" role="status" className="st-count">
              {visible.length === 0 && scan.state === 'completed' && scan.errors?.length === 0
                ? `No style suggestions in ${plural(scenesChecked, 'scene')}.`
                : `${plural(visible.length, 'suggestion')} in ${plural(new Set(visible.map((f) => f.sceneId)).size, 'scene')}.`}
            </p>
          )}
          {visible.length > 0 && (
            <>
              <nav aria-label="Group results" className="st-groupnav">
                <Link to={styleHref(bookId, { group: 'rule' })} className="btn btn-small" aria-current={group === 'rule' ? 'page' : undefined}>
                  By rule
                </Link>{' '}
                <Link to={styleHref(bookId, { group: 'chapter' })} className="btn btn-small" aria-current={group === 'chapter' ? 'page' : undefined}>
                  By chapter
                </Link>
              </nav>
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label} className="st-group-results">
                  <h3>
                    {g.label} <span className="badge">{g.items.length}</span>
                  </h3>
                  <ul className="cf-cards">
                    {g.items.map((f) => (
                      <ResultCard
                        key={f.id}
                        bookId={bookId}
                        finding={f}
                        chapters={scan.chapters}
                        status={cards[f.id]}
                        sceneChanged={changedScenes.includes(f.sceneId) && cards[f.id]?.phase !== 'applied'}
                        onApply={onApply}
                        onUndo={onUndo}
                        onDismiss={onDismiss}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </section>
      )}

      <details className="st-dismissed">
        <summary>{`Dismissed (${kept.length})`}</summary>
        {kept.length === 0 ? (
          <p className="muted">Nothing dismissed. A dismissed suggestion stays hidden until the passage changes; Restore brings it back on the next scan.</p>
        ) : (
          <ul>
            {kept.map((d) => (
              <DismissalItem key={d.slug} d={d} action="Restore" onAction={onRestore} />
            ))}
          </ul>
        )}
      </details>
      <details className="st-stale">
        <summary>{`No longer matching (${gone.length})`}</summary>
        {gone.length === 0 ? (
          <p className="muted">A dismissal whose passage was edited, so that it no longer matches anything, is listed here after a scan. Remove it to tidy up.</p>
        ) : (
          <ul>
            {gone.map((d) => (
              <DismissalItem key={d.slug} d={d} action="Remove" onAction={onRemove} />
            ))}
          </ul>
        )}
      </details>
    </main>
  );
}
