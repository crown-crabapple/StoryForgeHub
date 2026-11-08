// The AI Workspace page (M12 W8), drawn from what the server answered; WorkspaceView.jsx fetches and writes. Every section is its own component so a test can render it with
// fixture data. `readOnly` (a viewer or reviewer) turns every control off: the lists still read, nothing can be saved, locked, archived or changed.
import { useId, useState } from 'react';
import { sceneHref } from '../codex/model.js';
import { AI_LEVEL_CHOICES, DEFAULT_LEVEL, sourceText } from '../prefs/AiLevelSettings.jsx';
import { Link } from '../router.jsx';
import { statusActions, statusLabel, tasksPageHref } from '../tasks/model.js';
import { timelineHref } from '../timeline/model.js';
import { DEVELOPMENT_LABEL, SECTIONS, STATE_DOCS, chaptersText, entryHref, groupDocs, isDevelopment, missingStarters, stateAddress, threadHref, workspaceHref } from './model.js';

const labelOf = (/** @type {string} */ id) => AI_LEVEL_CHOICES.find((c) => c.id === id)?.label ?? id;

/** @param {{ error?: string | null, message?: string | null }} props */
function Notices({ error = null, message = null }) {
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="muted">
          {message}
        </p>
      )}
    </>
  );
}

/** The links between the sections: real links, the current one marked. @param {{ bookId: string, active: string }} props */
export function SectionNav({ bookId, active }) {
  return (
    <nav aria-label="AI Workspace sections" className="project-nav workspace-nav">
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.key}>
            <Link to={workspaceHref(bookId, { section: s.key })} className="project-tab" aria-current={s.key === active ? 'page' : undefined}>
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Overview: the book's AI level, what it allows, and the setup button.
 * @param {{ level: string | null, source?: string, list: { docs?: any[] } | null, readOnly?: boolean, busy?: boolean, error?: string | null, message?: string | null, onSetup?: () => void }} props
 */
export function OverviewSection({ level, source, list, readOnly = false, busy = false, error = null, message = null, onSetup = () => {} }) {
  const effective = level ?? DEFAULT_LEVEL;
  const missing = missingStarters(list);
  return (
    <section aria-labelledby="ws-overview-h">
      <h2 id="ws-overview-h">Overview</h2>
      <p>
        AI level for this book: <strong>{labelOf(effective)}</strong>
        {level !== null && <span className="muted">, from {sourceText(source)}</span>}. <Link to="/settings">Change it in Settings</Link>.
      </p>
      <p className="muted">The level always wins over what an AI connection&apos;s key allows. What each level allows:</p>
      <ul className="ai-level-legend">
        {AI_LEVEL_CHOICES.map((c) => (
          <li key={c.id} aria-current={c.id === effective ? 'true' : undefined}>
            <strong>{c.label}</strong>: {c.line}
          </li>
        ))}
      </ul>
      <Notices error={error} message={message} />
      {list !== null && missing.length > 0 && (
        <div>
          <p className="muted">These starter docs do not exist yet: {missing.join(', ')}.</p>
          {!readOnly && (
            <button type="button" className="btn" disabled={busy} onClick={onSetup}>
              {busy ? 'Setting up…' : 'Set up workspace'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** One row of the docs list. @param {{ bookId: string, doc: any, open: boolean }} props */
function DocRow({ bookId, doc, open }) {
  return (
    <li>
      <Link to={workspaceHref(bookId, { section: 'docs', doc: doc.path })} aria-current={open ? 'true' : undefined}>
        {doc.title}
      </Link>{' '}
      <span className="muted">
        {doc.path}
        {doc.locked ? ' · locked' : ''}
      </span>
    </li>
  );
}

/**
 * The editor of one doc: a plain textarea, Save (with the sha256 it was read at), Lock / Unlock and Archive. A locked doc, or a viewer, reads only.
 * @param {{ doc: any, readOnly?: boolean, busy?: boolean, onSave?: (body: string) => void, onLock?: (locked: boolean) => void, onArchive?: () => void }} props
 */
export function DocEditor({ doc, readOnly = false, busy = false, onSave = () => {}, onLock = () => {}, onArchive = () => {} }) {
  const id = useId();
  const [text, setText] = useState(doc.body ?? '');
  const frozen = readOnly || doc.locked === true;
  return (
    <div className="workspace-doc">
      <h3>{doc.title}</h3>
      <p className="muted">{doc.path}</p>
      {isDevelopment(doc.path) && <p className="workspace-dev-note">{DEVELOPMENT_LABEL}</p>}
      {doc.locked && <p role="note">This doc is locked: the AI cannot change it, and neither can you until you unlock it.</p>}
      <div className="field">
        <label htmlFor={`${id}-body`}>Body of {doc.title}</label>
        <textarea id={`${id}-body`} rows={16} value={text} readOnly={frozen} onChange={(e) => setText(e.target.value)} />
      </div>
      {!readOnly && (
        <p>
          <button type="button" className="btn" disabled={busy || frozen} onClick={() => onSave(text)}>
            Save
          </button>{' '}
          <button type="button" className="btn" disabled={busy} onClick={() => onLock(!doc.locked)}>
            {doc.locked ? 'Unlock' : 'Lock'}
          </button>{' '}
          <button type="button" className="btn" disabled={busy || doc.locked === true} onClick={onArchive}>
            Archive
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Docs: the workspace/* and development/* docs, and the open one.
 * @param {{ bookId: string, list: { docs?: any[] } | null, open: any | null, openPath?: string | null, readOnly?: boolean, busy?: boolean, error?: string | null, message?: string | null,
 *   onSave?: (body: string) => void, onLock?: (locked: boolean) => void, onArchive?: () => void }} props
 */
export function DocsSection({ bookId, list, open, openPath = null, readOnly = false, busy = false, error = null, message = null, onSave, onLock, onArchive }) {
  const { workspace, development } = groupDocs(list);
  return (
    <section aria-labelledby="ws-docs-h">
      <h2 id="ws-docs-h">Docs</h2>
      <Notices error={error} message={message} />
      {list === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : (
        <div className="workspace-docs">
          <div>
            <h3>Workspace docs</h3>
            {workspace.length === 0 ? (
              <p className="muted">No workspace docs yet. Set them up from the Overview.</p>
            ) : (
              <ul>
                {workspace.map((d) => (
                  <DocRow key={d.path} bookId={bookId} doc={d} open={d.path === openPath} />
                ))}
              </ul>
            )}
            <h3>Development docs</h3>
            <p className="muted">{DEVELOPMENT_LABEL}</p>
            {development.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <ul>
                {development.map((d) => (
                  <DocRow key={d.path} bookId={bookId} doc={d} open={d.path === openPath} />
                ))}
              </ul>
            )}
          </div>
          <div>
            {open ? <DocEditor key={`${open.path}|${open.sha256}`} doc={open} readOnly={readOnly} busy={busy} onSave={onSave} onLock={onLock} onArchive={onArchive} /> : <p className="muted">Pick a doc to read it.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Chapter state: the four state docs of one chapter, with their lock state, and "Lock chapter state".
 * @param {{ bookId: string, chapters: number[], chapter: number | null, docs: Record<string, any | null>, readOnly?: boolean, busy?: boolean, error?: string | null, message?: string | null,
 *   onChapter?: (n: number) => void, onLockChapter?: (locked: boolean) => void }} props `docs`: name -> the doc (with body) or null when it does not exist
 */
export function StateSection({ bookId, chapters, chapter, docs, readOnly = false, busy = false, error = null, message = null, onChapter = () => {}, onLockChapter = () => {} }) {
  const id = useId();
  const present = STATE_DOCS.map((n) => docs[n]).filter(Boolean);
  const allLocked = present.length > 0 && present.every((d) => d.locked);
  return (
    <section aria-labelledby="ws-state-h">
      <h2 id="ws-state-h">Chapter state</h2>
      <p className="muted">Where each chapter stands: the situation, who is there, what they know and what they carry. The AI keeps these up to date; lock a chapter&apos;s state once it is final.</p>
      <Notices error={error} message={message} />
      {chapters.length === 0 ? (
        <p className="muted">This book has no chapters yet.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`${id}-chapter`}>Chapter</label>
            <select id={`${id}-chapter`} value={chapter ?? ''} onChange={(e) => onChapter(Number(e.target.value))}>
              {chapter === null && <option value="">Pick a chapter</option>}
              {chapters.map((n) => (
                <option key={n} value={n}>
                  Chapter {n}
                </option>
              ))}
            </select>
          </div>
          {chapter !== null && (
            <>
              {!readOnly && present.length > 0 && (
                <p>
                  <button type="button" className="btn" disabled={busy} onClick={() => onLockChapter(!allLocked)}>
                    {allLocked ? 'Unlock chapter state' : 'Lock chapter state'}
                  </button>
                </p>
              )}
              <div className="workspace-state-grid">
                {STATE_DOCS.map((name) => {
                  const d = docs[name] ?? null;
                  return (
                    <article key={name} aria-label={`${name} of chapter ${chapter}`} className="workspace-state-doc">
                      <h3>{name[0].toUpperCase() + name.slice(1)}</h3>
                      {d === null ? (
                        <p className="muted">Not written yet.</p>
                      ) : (
                        <>
                          <p className="muted">{d.locked ? 'Locked' : 'Not locked'}</p>
                          <pre className="workspace-state-body">{d.body}</pre>
                          {!readOnly && <Link to={workspaceHref(bookId, { section: 'docs', doc: stateAddress(chapter, name) })}>Edit in Docs</Link>}
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** The threads table (promises or questions). @param {{ bookId: string, title: string, rows: any[], overdue: Set<string> }} props */
function ThreadTable({ bookId, title, rows, overdue }) {
  return (
    <>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="workspace-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Planted in chapter</th>
              <th scope="col">Payoff in chapter</th>
              <th scope="col">Overdue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={threadHref(bookId, t.id)}>{t.title}</Link>
                </td>
                <td>{t.status}</td>
                <td>{chaptersText(t.setup_chapters)}</td>
                <td>{chaptersText(t.payoff_chapters)}</td>
                <td>{overdue.has(t.id) ? 'Overdue' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** A chapter select with an optional "all" choice. @param {{ label: string, value: number | null, chapters: number[], allLabel?: string, onChange: (n: number | null) => void }} props */
function ChapterSelect({ label, value, chapters, allLabel = 'All chapters', onChange }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">{allLabel}</option>
        {chapters.map((n) => (
          <option key={n} value={n}>
            Chapter {n}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Ledgers: promises and questions, clues, cast by chapter, what a character knows, state events. Read-only lists; a thread is edited in the Threads view.
 * @param {{ bookId: string, ledger: any | null, overdue?: Set<string>, chapters: number[], entries: any[], cast: any[] | null, castChapter: number | null, knowledge: any | null,
 *   character: string | null, knowledgeAt: number | null, stateEvents: any[] | null, eventsChapter: number | null,
 *   onCastChapter?: (n: number | null) => void, onCharacter?: (id: string | null) => void, onKnowledgeAt?: (n: number | null) => void, onEventsChapter?: (n: number | null) => void }} props
 */
export function LedgersSection({ bookId, ledger, overdue = new Set(), chapters, entries, cast, castChapter, knowledge, character, knowledgeAt, stateEvents, eventsChapter, onCastChapter = () => {}, onCharacter = () => {}, onKnowledgeAt = () => {}, onEventsChapter = () => {} }) {
  const charId = useId();
  const withCast = (cast ?? []).filter((s) => s.cast.length > 0);
  return (
    <section aria-labelledby="ws-ledgers-h">
      <h2 id="ws-ledgers-h">Ledgers</h2>
      <p className="muted">What the book has promised, planted and recorded. These lists only read; change a promise or question in the Threads view.</p>
      {ledger === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : (
        <>
          <ThreadTable bookId={bookId} title="Promises" rows={ledger.promises} overdue={overdue} />
          <ThreadTable bookId={bookId} title="Questions" rows={ledger.questions} overdue={overdue} />
          <h3>Clues</h3>
          {ledger.clues.length === 0 ? (
            <p className="muted">No clues are planned.</p>
          ) : (
            <table className="workspace-table">
              <caption className="sr-only">Clues</caption>
              <thead>
                <tr>
                  <th scope="col">Clue</th>
                  <th scope="col">Status</th>
                  <th scope="col">Planted in chapter</th>
                  <th scope="col">Revealed in chapter</th>
                </tr>
              </thead>
              <tbody>
                {ledger.clues.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.planted?.length > 0 ? <Link to={sceneHref(bookId, c.planted[0])}>{c.fact}</Link> : c.fact}
                      {c.red_herring ? ' (red herring)' : ''}
                    </td>
                    <td>{c.status}</td>
                    <td>{chaptersText(c.planted_chapters)}</td>
                    <td>{c.revealed_chapter ?? 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3>Cast by chapter</h3>
      <ChapterSelect label="Cast: chapter" value={castChapter} chapters={chapters} onChange={onCastChapter} />
      {cast === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : withCast.length === 0 ? (
        <p className="muted">No cast is set for {castChapter === null ? 'any scene' : `chapter ${castChapter}`}.</p>
      ) : (
        <ul>
          {withCast.map((s) => (
            <li key={s.scene}>
              <Link to={sceneHref(bookId, s.scene)}>{s.title ?? s.scene}</Link> <span className="muted">(chapter {s.chapter})</span>:{' '}
              {s.cast.map((m, i) => (
                <span key={`${m.entry}-${i}`}>
                  {i > 0 ? ', ' : ''}
                  {m.id ? <Link to={entryHref(bookId, m.id)}>{m.name ?? m.entry}</Link> : (m.name ?? m.entry)} ({m.role ?? 'appears'})
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      <h3>Knowledge</h3>
      <div className="field">
        <label htmlFor={charId}>Character</label>
        <select id={charId} value={character ?? ''} onChange={(e) => onCharacter(e.target.value === '' ? null : e.target.value)}>
          <option value="">Pick a character</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name ?? e.slug ?? e.id}
            </option>
          ))}
        </select>
      </div>
      <ChapterSelect label="Knows by the end of" value={knowledgeAt} chapters={chapters} allLabel="The whole book" onChange={onKnowledgeAt} />
      {character === null ? (
        <p className="muted">Pick a character to see what they know.</p>
      ) : knowledge === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : knowledge.facts.length === 0 ? (
        <p className="muted">{knowledge.character?.name ?? 'This character'} knows nothing recorded yet.</p>
      ) : (
        <ul>
          {knowledge.facts.map((f) => (
            <li key={f.fact}>
              {f.text} <span className="muted">({f.how}, {f.chapter === null ? 'chapter unknown' : `chapter ${f.chapter}`})</span>
            </li>
          ))}
        </ul>
      )}

      <h3>State events</h3>
      <ChapterSelect label="State events: chapter" value={eventsChapter} chapters={chapters} onChange={onEventsChapter} />
      {stateEvents === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : stateEvents.length === 0 ? (
        <p className="muted">No state events{eventsChapter === null ? '' : ` in chapter ${eventsChapter}`}.</p>
      ) : (
        <ul>
          {stateEvents.map((ev, i) => (
            <li key={`${ev.event_id}-${i}`}>
              {ev.subject?.id ? <Link to={entryHref(bookId, ev.subject.id)}>{ev.subject.name ?? ev.subject.slug}</Link> : (ev.subject?.name ?? ev.subject?.slug)}: {ev.kind}
              {ev.value ? ` ${ev.value}` : ''} <span className="muted">(chapter {ev.chapter ?? 'unknown'}, </span>
              <Link to={timelineHref(bookId, { event: ev.event_id })}>{ev.event ?? 'event'}</Link>
              <span className="muted">)</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * AI tasks: the tasks made for the AI, with the status buttons.
 * @param {{ bookId: string, data: { tasks?: any[] } | null, readOnly?: boolean, busy?: boolean, error?: string | null, message?: string | null, onStatus?: (task: any, to: string) => void }} props
 */
export function AiTasksSection({ bookId, data, readOnly = false, busy = false, error = null, message = null, onStatus = () => {} }) {
  const tasks = data?.tasks ?? null;
  return (
    <section aria-labelledby="ws-tasks-h">
      <h2 id="ws-tasks-h">AI tasks</h2>
      <p className="muted">Tasks marked for the AI. The AI can change their status too; the whole list is on the Tasks page.</p>
      <Notices error={error} message={message} />
      {tasks === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : tasks.length === 0 ? (
        <p className="muted">No task is marked for the AI.</p>
      ) : (
        <ul className="workspace-tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <p>
                <Link to={tasksPageHref(bookId, t.id)}>{t.title}</Link> <span className="muted">{statusLabel(t.status)}</span>
              </p>
              {!readOnly && (
                <p>
                  {statusActions(t.status).map((a) => (
                    <button key={a.to} type="button" className="btn btn-small" disabled={busy} aria-label={`${a.label}: ${t.title}`} onClick={() => onStatus(t, a.to)}>
                      {a.label}
                    </button>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
