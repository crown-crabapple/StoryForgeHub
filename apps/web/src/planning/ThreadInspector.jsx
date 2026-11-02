import { useState } from 'react';
import { codexHref } from '../codex/model.js';
import { ProseView } from '../ProseView.jsx';
import { Link } from '../router.jsx';
import { StateChip, Suggestions, ThreadCounts } from './ThreadsView.jsx';
import { ROLES, chapterShort, sceneHref, stateLabel, stateOptions } from './model.js';

/** Add a scene to one list: a picker of the scenes that are not in it yet and an Add button. */
function ScenePicker({ model, role, thread, onAdd }) {
  const [value, setValue] = useState('');
  const inList = new Set(thread[role.list]);
  const options = model.scenes.filter((s) => !inList.has(s.id));
  return (
    <form
      className="thread-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== '') {
          onAdd(thread, role.list, value);
          setValue('');
        }
      }}
    >
      <select aria-label={`Add a scene to ${role.label}`} value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Add a scene...</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {chapterShort(s.chapter)}: {s.title || 'Untitled scene'}
          </option>
        ))}
      </select>
      <button type="submit" className="btn row-button" disabled={value === ''}>
        Add
      </button>
    </form>
  );
}

/**
 * The right column for one thread: title, kind, state (a select with the six states, plus the legacy one a thread already has), the lifecycle suggestions,
 * its text (read-only; "Edit text" opens the editor the scenes use), the scenes of each list (links; add with the picker, remove) and its characters.
 * Presentational: the page gives the handlers; a handler that is missing hides its control.
 * @param {{ bookId: string, thread: import('./model.js').ThreadRow | null, model: ReturnType<typeof import('./model.js').buildModel>, body?: string | null,
 *   objects?: { id: string, kind: string, slug: string | null, title: string | null, type?: string | null }[] | null,
 *   onState?: (thread: any, status: string) => void, onSuggest?: (thread: any, to: string) => void, onEditText?: (thread: any) => void,
 *   onAddScene?: (thread: any, list: string, sceneId: string) => void, onRemoveScene?: (thread: any, list: string, sceneId: string) => void,
 *   onSetCharacters?: (thread: any, characters: string[]) => void }} props
 */
export function ThreadInspector({ bookId, thread, model, body = null, objects = null, onState, onSuggest, onEditText, onAddScene, onRemoveScene, onSetCharacters }) {
  const [character, setCharacter] = useState('');
  if (!thread) return <p className="muted">Select a thread to see its details.</p>;
  const entries = (objects ?? []).filter((o) => o.kind === 'entry');
  const nameOf = (ref) => entries.find((o) => o.slug === ref || o.id === ref);
  const addable = entries.filter((o) => o.type === 'character' && o.slug && !thread.characters.includes(o.slug));
  return (
    <div className="thread-inspector" data-thread-id={thread.id}>
      <div className="thread-inspector-head">
        <h2>{thread.title}</h2>
        <span className="muted">{thread.kind ?? 'no kind'}</span>
        <StateChip state={thread.status} />
        <ThreadCounts counts={thread.counts} />
      </div>
      {onState && (
        <div className="form-row">
          <label>
            <span className="form-label">State</span>
            <select name="state" value={thread.status ?? ''} onChange={(e) => onState(thread, e.target.value)}>
              {thread.status === null && <option value="">No state</option>}
              {stateOptions(thread.status).map((s) => (
                <option key={s} value={s}>
                  {stateLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <Suggestions thread={thread} onSuggest={onSuggest} />
      {thread.problems.filter((p) => p.severity === 'warning' || p.severity === 'error').length > 0 && (
        <ul className="thread-problems">
          {thread.problems.map((p) => (
            <li key={`${p.code}-${p.location}`} className={`diag diag-${p.severity}`}>
              <strong>{p.code}</strong> {p.message}
            </li>
          ))}
        </ul>
      )}
      <section className="codex-detail-section">
        <h3>Text</h3>
        {body === null ? <p className="muted">Loading...</p> : body.trim() === '' ? <p className="muted">Nothing written yet.</p> : <ProseView source={body} />}
        {onEditText && (
          <button type="button" className="btn row-button" onClick={() => onEditText(thread)}>
            Edit text
          </button>
        )}
      </section>
      {ROLES.map((role) => (
        <section key={role.list} className="codex-detail-section thread-list-section" data-list={role.list} aria-label={`Scenes: ${role.label}`}>
          <h3>
            {role.key} - {role.label[0].toUpperCase() + role.label.slice(1)}
          </h3>
          {thread[role.list].length === 0 ? (
            <p className="muted">No scenes yet.</p>
          ) : (
            <ul className="thread-scenes">
              {thread[role.list].map((id) => {
                const s = model.sceneById.get(id);
                const name = s?.title || 'Untitled scene';
                return (
                  <li key={id}>
                    <Link to={sceneHref(bookId, id)}>
                      {s ? `${chapterShort(s.chapter)}: ${name}` : id}
                    </Link>
                    {onRemoveScene && (
                      <button type="button" className="btn row-button" aria-label={`Remove ${name} from ${role.label}`} onClick={() => onRemoveScene(thread, role.list, id)}>
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {onAddScene && <ScenePicker model={model} role={role} thread={thread} onAdd={onAddScene} />}
        </section>
      ))}
      <section className="codex-detail-section" aria-label="Characters">
        <h3>Characters</h3>
        {thread.characters.length === 0 ? (
          <p className="muted">No characters listed.</p>
        ) : (
          <ul className="thread-scenes">
            {thread.characters.map((ref) => {
              const o = nameOf(ref);
              const name = o?.title ?? ref;
              return (
                <li key={ref}>
                  {o ? <Link to={codexHref(bookId, { entry: o.id })}>{name}</Link> : <span>{name}</span>}
                  {onSetCharacters && (
                    <button type="button" className="btn row-button" aria-label={`Remove ${name} from characters`} onClick={() => onSetCharacters(thread, thread.characters.filter((c) => c !== ref))}>
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {onSetCharacters && addable.length > 0 && (
          <form
            className="thread-picker"
            onSubmit={(e) => {
              e.preventDefault();
              if (character !== '') {
                onSetCharacters(thread, [...thread.characters, character]);
                setCharacter('');
              }
            }}
          >
            <select aria-label="Add a character" value={character} onChange={(e) => setCharacter(e.target.value)}>
              <option value="">Add a character...</option>
              {addable.map((o) => (
                <option key={o.id} value={o.slug}>
                  {o.title ?? o.slug}
                </option>
              ))}
            </select>
            <button type="submit" className="btn row-button" disabled={character === ''}>
              Add
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
