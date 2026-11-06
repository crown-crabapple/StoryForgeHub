import { useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { viewHref } from '../planning/model.js';
import { STORY_FIELDS, fieldValue, planHref } from './requests.js';
import { sceneName } from './model.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One story field: a labelled input. Enter or leaving it saves a change. `onSave(value)` returns a promise of true (saved) or false (refused: the field may be tried again).
 * @param {{ id: string, label: string, saved: string, onSave: (value: string | null) => Promise<boolean> | boolean | void }} props
 */
function StoryField({ id, label, saved, onSave }) {
  const [text, setText] = useState(saved);
  const sent = useRef(fieldValue(saved));
  const commit = async () => {
    const value = fieldValue(text);
    if (value === sent.current) return;
    sent.current = value;
    const ok = await onSave(value);
    if (ok === false) sent.current = fieldValue(saved);
  };
  return (
    <form
      className="plan-story-field"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" value={text} placeholder="Not set" autoComplete="off" onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </form>
  );
}

/** The protagonist: a select of the book's character entries (a slug that is not among them is kept as an option so nothing is lost). */
function ProtagonistField({ id, label, saved, characters, onSave }) {
  const known = characters.some((c) => c.slug === saved);
  return (
    <div className="plan-story-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} defaultValue={saved} onChange={(e) => onSave(e.target.value === '' ? null : e.target.value)}>
        <option value="">Not set</option>
        {saved !== '' && !known && <option value={saved}>{saved} (not a character entry)</option>}
        {characters.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.title ?? c.slug}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The notes text of the story plan, with an explicit Save button. */
function StoryNotes({ saved, onSave }) {
  const [text, setText] = useState(saved);
  const changed = text !== saved;
  return (
    <form
      className="plan-story-notes"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(text);
      }}
    >
      <label htmlFor="story-notes">Story notes</label>
      <textarea id="story-notes" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      <div>
        <button type="submit" className="btn" disabled={!changed}>
          Save notes
        </button>
      </div>
    </form>
  );
}

/**
 * The Overview of the Plan tab: the story plan, the counts as sentences that lead into Flow, and the scenes not linked yet. Presentational.
 * @param {{ bookId: string, overview: any, characters?: { slug: string, title?: string }[], message?: string | null, error?: string | null,
 *   handlers?: { onSaveField?: (key: string, value: string | null) => Promise<boolean> | boolean | void, onSaveNotes?: (text: string) => void, onConnect?: () => void } }} props
 *   `overview` is GET /plan-overview; `characters` the character entries of the Codex (for the protagonist).
 */
export function OverviewView({ bookId, overview, characters = [], message = null, error = null, handlers = {} }) {
  const { story, counts, unlinked } = overview;
  const flow = (patch = {}) => planHref(bookId, { view: 'flow', ...patch });
  const noScenes = counts.scenes === 0;
  return (
    <div className="plan-overview">
      <section aria-labelledby="plan-story-h" className="plan-block">
        <h2 id="plan-story-h">Story plan</h2>
        {message && (
          <p className="muted" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="plan-story-fields">
          {STORY_FIELDS.map((f) => {
            const saved = story.fields?.[f.key] ?? '';
            const key = `${f.key}:${story.sha256 ?? ''}:${saved}`;
            return f.key === 'protagonist' ? (
              <ProtagonistField key={key} id="story-protagonist" label={f.label} saved={saved} characters={characters} onSave={(v) => handlers.onSaveField?.(f.key, v)} />
            ) : (
              <StoryField key={key} id={`story-${f.key}`} label={f.label} saved={saved} onSave={(v) => handlers.onSaveField?.(f.key, v)} />
            );
          })}
        </div>
        <StoryNotes key={`notes:${story.sha256 ?? ''}`} saved={story.body ?? ''} onSave={(t) => handlers.onSaveNotes?.(t)} />
      </section>

      <section aria-labelledby="plan-counts-h" className="plan-block">
        <h2 id="plan-counts-h">Where the plan stands</h2>
        {noScenes ? (
          <p>
            This book has no scenes yet. Add scenes in the <Link to={viewHref(bookId, 'write')}>manuscript</Link>, then plan and connect them here.
          </p>
        ) : (
          <ul className="plan-counts">
            <li>
              <Link to={flow()}>{`${counts.planned_scenes} of ${counts.scenes} ${counts.scenes === 1 ? 'scene has' : 'scenes have'} a plan`}</Link>
            </li>
            <li>
              <Link to={flow({ mode: 'list', filter: 'unlinked' })}>{`${plural(counts.linked_scenes, 'scene', 'scenes')} linked, ${counts.unlinked_scenes} not linked`}</Link>
            </li>
            <li>
              <Link to={flow({ mode: 'list' })}>{plural(counts.links, 'link', 'links')} between scenes</Link>
            </li>
            {counts.broken_links > 0 && (
              <li>
                <Link to={flow({ mode: 'list' })}>{`${plural(counts.broken_links, 'link points', 'links point')} to a missing scene`}</Link>
              </li>
            )}
            {counts.archived_links > 0 && (
              <li>
                <Link to={flow({ mode: 'list' })}>{plural(counts.archived_links, 'archived link', 'archived links')}</Link>
              </li>
            )}
            {typeof counts.arcs === 'number' && (
              <li>
                <Link to={planHref(bookId, { view: 'arcs' })}>{plural(counts.arcs, 'character arc', 'character arcs')}</Link>
              </li>
            )}
            {typeof counts.relationships === 'number' && (
              <li>
                <Link to={planHref(bookId, { view: 'arcs' })}>{plural(counts.relationships, 'relationship', 'relationships')}</Link>
              </li>
            )}
            {typeof counts.structures === 'number' && (
              <li>
                <Link to={planHref(bookId, { view: 'structure' })}>{plural(counts.structures, 'structure', 'structures')}</Link>
              </li>
            )}
            {typeof counts.structures === 'number' && (
              <li>
                {overview.primary_structure ? (
                  <Link to={planHref(bookId, { view: 'structure', structure: overview.primary_structure.slug })}>{`Primary: ${overview.primary_structure.name}`}</Link>
                ) : (
                  <Link to={planHref(bookId, { view: 'structure' })}>No primary structure</Link>
                )}
              </li>
            )}
            <li>
              <Link to={viewHref(bookId, 'threads')}>{plural(counts.threads, 'plot thread', 'plot threads')}</Link>
            </li>
          </ul>
        )}
        <p className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={() => handlers.onConnect?.()} disabled={counts.scenes < 2}>
            Connect scenes…
          </button>{' '}
          <Link to={flow()} className="btn">
            Open Flow
          </Link>
        </p>
      </section>

      {!noScenes && (
        <section aria-labelledby="plan-unlinked-h" className="plan-block">
          <h2 id="plan-unlinked-h">Scenes not linked yet</h2>
          {unlinked.length === 0 ? (
            <p className="muted">Every scene has at least one link.</p>
          ) : (
            <>
              <ul className="plan-unlinked">
                {unlinked.map((s) => (
                  <li key={s.id}>
                    <Link to={flow({ node: s.id })}>{sceneName(s.title)}</Link>
                  </li>
                ))}
              </ul>
              {counts.unlinked_scenes > unlinked.length && <p className="muted">{`and ${counts.unlinked_scenes - unlinked.length} more (see Flow).`}</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
