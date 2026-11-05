import { Link } from '../router.jsx';
import { codexHref } from '../codex/model.js';
import { viewHref } from '../planning/model.js';
import { timelineHref } from '../timeline/model.js';
import { Dialog } from '../shell/Dialog.jsx';
import { NoteProse } from './NoteProse.jsx';
import { KIND_LABEL, NOTE_SECTIONS, citationOf, filterNotes, groupSceneNotes, notesHref, sceneLineHref, sectionTitle, sidebarCounts, updatedLabel } from './model.js';

/** Where a linked entry, thread or event lives. @param {string} bookId @param {{ kind: string | null, id: string | null, slug: string | null }} l */
export function linkTarget(bookId, l) {
  if (l.kind === 'entry') return codexHref(bookId, { entry: l.id });
  if (l.kind === 'thread') return viewHref(bookId, 'threads', { thread: l.slug ?? l.id });
  if (l.kind === 'event') return timelineHref(bookId, { event: l.id });
  return null;
}

/** The links of a note as chips (entries, threads, events); a link nothing resolves is marked, not hidden. @param {{ bookId: string, links: any[] }} props */
export function LinkChips({ bookId, links }) {
  if (links.length === 0) return <span className="muted">Not linked to anything yet.</span>;
  return (
    <ul className="note-chips">
      {links.map((l) => {
        const to = linkTarget(bookId, l);
        return (
          <li key={l.ref}>
            {to ? (
              <Link className="link-chip" to={to} title={`${l.kind}: ${l.slug ?? l.ref}`}>
                {l.name ?? l.ref}
              </Link>
            ) : (
              <span className="link-chip" data-broken="true" title="Nothing in the book has this name">
                {l.ref} <span className="muted">(not found)</span>
              </span>
            )}
            {l.state === 'archived' && <span className="tag">archived</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** The sources of a research note as citations. @param {{ bookId: string, sources: any[] }} props */
export function SourceChips({ bookId, sources }) {
  if (sources.length === 0) return <span className="muted">No sources cited.</span>;
  return (
    <ul className="note-chips">
      {sources.map((s) => (
        <li key={s.cite_key}>
          {s.id ? (
            <Link className="link-chip note-cite" to={notesHref(bookId, { section: 'sources', note: s.id })} title={s.title ?? s.cite_key}>
              [@{s.cite_key}]
            </Link>
          ) : (
            <span className="link-chip" data-broken="true">
              [@{s.cite_key}] <span className="muted">(not found)</span>
            </span>
          )}
          {s.title && <span className="muted"> {s.title}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * One note for reading: fields (tags, canon flag with its explanation, links, sources) and the text rendered. Presentational: `note` is GET /notes/:id.
 * @param {{ bookId: string, note: any | null, sources?: Map<string, string>, handlers?: { onEditText?: (n: any) => void, onEdit?: (n: any) => void, onArchive?: (n: any) => void, onRestore?: (n: any) => void } }} props
 */
export function NoteView({ bookId, note, sources, handlers = {} }) {
  if (!note) return <p className="muted">Select a note to read it.</p>;
  const src = note.source ?? {};
  const facts = Object.entries({ Author: src.author, Year: src.year, Type: src.type, Publisher: src.publisher, Locator: src.locator, Accessed: src.accessed }).filter(([, v]) => v);
  return (
    <article className="note-view" aria-label={note.title ?? 'Note'}>
      <header className="note-head">
        <p className="muted note-kind">{KIND_LABEL[note.kind] ?? note.kind}</p>
        <h2>{note.title}</h2>
        {note.stale && <p className="error">This file cannot be read right now. Showing the last valid version.</p>}
        {note.archived && <p className="muted">Archived.</p>}
      </header>

      <dl className="codex-facts note-facts">
        {note.kind === 'research' && (
          <>
            <div>
              <dt>Tags</dt>
              <dd>{note.tags.length > 0 ? note.tags.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">—</span>}</dd>
            </div>
            <div>
              <dt>Canon</dt>
              <dd>
                {note.canon ? 'Canon' : 'Not canon'}
                <span className="muted note-canon-why">
                  {note.canon
                    ? ' Continuity checks may treat what this note says as fact.'
                    : ' Research is background. Continuity checks do not treat it as fact unless you mark it canon.'}
                </span>
              </dd>
            </div>
            <div>
              <dt>Links</dt>
              <dd>
                <LinkChips bookId={bookId} links={note.links} />
              </dd>
            </div>
            <div>
              <dt>Sources</dt>
              <dd>
                <SourceChips bookId={bookId} sources={note.sources} />
              </dd>
            </div>
          </>
        )}
        {note.kind === 'doc' && (
          <div>
            <dt>Locked</dt>
            <dd>{note.locked ? 'Yes: StoryForge asks before editing it.' : 'No'}</dd>
          </div>
        )}
        {note.kind === 'source' && (
          <>
            <div>
              <dt>Cite as</dt>
              <dd>
                <code>[@{note.cite_key}]</code>
              </dd>
            </div>
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {src.url && (
              <div>
                <dt>URL</dt>
                <dd>
                  <NoteProse source={`[${src.url}](${src.url})`} notePath={note.rel ?? note.path} bookId={bookId} />
                </dd>
              </div>
            )}
          </>
        )}
        <div>
          <dt>File</dt>
          <dd>
            <code>{note.path}</code>
            {updatedLabel(note.updated_at) && <span className="muted"> · updated {updatedLabel(note.updated_at)}</span>}
          </dd>
        </div>
      </dl>

      {typeof note.body !== 'string' ? (
        <p className="muted">Loading…</p>
      ) : note.body.trim() !== '' ? (
        <NoteProse source={note.body} notePath={note.rel ?? note.path} bookId={bookId} sources={sources} />
      ) : (
        <p className="muted">Nothing written yet.</p>
      )}

      {!note.stale && (
        <div className="codex-actions">
          {!note.archived && handlers.onEditText && (
            <button type="button" className="btn" onClick={() => handlers.onEditText(note)}>
              Edit text…
            </button>
          )}
          {!note.archived && handlers.onEdit && (
            <button type="button" className="btn" onClick={() => handlers.onEdit(note)}>
              Edit fields…
            </button>
          )}
          {!note.archived && handlers.onArchive && (
            <button type="button" className="btn" onClick={() => handlers.onArchive(note)}>
              Archive…
            </button>
          )}
          {note.archived && handlers.onRestore && (
            <button type="button" className="btn" onClick={() => handlers.onRestore(note)}>
              Restore…
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** Scene notes: every author note of the manuscript, grouped by chapter and scene; each jumps to its line in the editor. Read-only. @param {{ bookId: string, data: { scenes?: any[] } | null }} props */
export function SceneNotesList({ bookId, data }) {
  const groups = groupSceneNotes(data);
  if (groups.length === 0) {
    return (
      <div className="empty-state">
        <h2>No scene notes.</h2>
        <p>An author note is a comment in a scene, written <code>&lt;!-- note: like this --&gt;</code>. They are listed here, never exported to readers.</p>
      </div>
    );
  }
  return (
    <div className="note-scenes">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 className="tl-when">{g.label}</h2>
          {g.scenes.map((s) => (
            <div key={s.id} className="note-scene">
              <h3>{s.title || 'Untitled scene'}</h3>
              <ul className="notes-list">
                {s.notes.map((n) => (
                  <li key={`${n.line}-${n.text}`}>
                    <Link className="note-jump" to={sceneLineHref(bookId, s.id, n.line)}>
                      <span className="note-line">Line {n.line}</span> <span className="note-text">{n.text}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * The Notes page (/books/:id/notes): the sidebar (All, Research, Planning docs, Sources, Scene notes, and the tags with counts), the note board with search, and the open note in a dialog.
 * Presentational: everything arrives by props, so tests can render it with fixture JSON.
 * @param {{ bookId: string, data: { notes: any[], tags: { tag: string, count: number }[] }, sceneNotes?: { scenes?: any[] } | null, section?: string, tag?: string | null,
 *   query?: string, textIds?: Set<string> | null, selectedId?: string | null, note?: any | null, handlers?: Record<string, any>, editor?: import('react').ReactNode }} props
 *   handlers: onQuery(q), onNew(kind), onEditText(note), onEdit(note), onArchive(note), onRestore(note), onCloseNote()
 */
export function NotesPage({ bookId, data, sceneNotes = null, section = 'all', tag = null, query = '', textIds = null, selectedId = null, note = null, handlers = {}, editor = null }) {
  const notes = data?.notes ?? [];
  const sceneCount = (sceneNotes?.scenes ?? []).reduce((n, s) => n + s.notes.length, 0);
  const counts = sidebarCounts(notes, sceneCount);
  const shown = filterNotes(notes, { section, tag, query, textIds });
  const sources = new Map(notes.filter((n) => n.kind === 'source' && n.cite_key).map((n) => [n.cite_key, citationOf(n)]));
  const selected = shown.find((n) => n.id === selectedId) ?? null;
  const openNote = note ?? (selected ? { ...selected } : null);
  return (
    <div className="nt">
      <aside aria-label="Notes sections" className="codex-sidebar">
        <h2 className="codex-sidebar-title">Notes</h2>
        {NOTE_SECTIONS.map((r) => (
          <Link key={r.key} to={notesHref(bookId, { section: r.key })} className="codex-cat" aria-current={r.key === section && !tag ? 'true' : undefined}>
            <span>{r.label}</span>
            <span className="codex-cat-count">{counts[r.key]}</span>
          </Link>
        ))}
        {counts.archived > 0 && (
          <Link to={notesHref(bookId, { section: 'archived' })} className="codex-cat" data-kind="archived" aria-current={section === 'archived' ? 'true' : undefined}>
            <span>Archived</span>
            <span className="codex-cat-count">{counts.archived}</span>
          </Link>
        )}
        <h2 className="codex-sidebar-title note-tags-title">Tags</h2>
        {(data?.tags ?? []).length === 0 && <p className="muted note-tags-empty">No tags yet.</p>}
        {(data?.tags ?? []).map((t) => (
          <Link key={t.tag} to={notesHref(bookId, { section: 'research', tag: t.tag })} className="codex-cat" aria-current={tag === t.tag ? 'true' : undefined}>
            <span>{t.tag}</span>
            <span className="codex-cat-count">{t.count}</span>
          </Link>
        ))}
      </aside>

      <main id="main" tabIndex={-1} className="nt-main">
        {editor ?? (
          <>
            <div className="codex-head">
              <h1>{tag ? `Tag: ${tag}` : sectionTitle(section)}</h1>
              {section !== 'scene-notes' && <span className="codex-counts">{shown.length === 1 ? '1 note' : `${shown.length} notes`}</span>}
            </div>
            {section === 'scene-notes' ? (
              <SceneNotesList bookId={bookId} data={sceneNotes} />
            ) : (
              <>
                <div className="toolbar nt-toolbar">
                  <input type="search" className="toolbar-filter" aria-label="Search notes" placeholder="Search title, tags and text" value={query} onChange={(e) => handlers.onQuery?.(e.target.value)} />
                  {handlers.onNew && (
                    <>
                      <button type="button" className="btn btn-primary" onClick={() => handlers.onNew('research')}>
                        New research note
                      </button>
                      <button type="button" className="btn" onClick={() => handlers.onNew('doc')}>
                        New planning doc
                      </button>
                      <button type="button" className="btn" onClick={() => handlers.onNew('source')}>
                        New source
                      </button>
                    </>
                  )}
                </div>
                {shown.length === 0 ? (
                  <div className="empty-state">
                    <h2>{query.trim() !== '' || tag ? 'No notes match.' : 'Nothing here yet.'}</h2>
                    <p>{query.trim() !== '' || tag ? 'Clear the search or the tag to see more.' : 'Research, planning documents and sources you add are listed here.'}</p>
                  </div>
                ) : (
                  <ul className="nt-board" aria-label="Notes">
                    {shown.map((n) => (
                      <li key={n.id}>
                        <Link className="nt-card" to={notesHref(bookId, { section: n.archived ? 'archived' : section, tag, note: n.id })} aria-current={n.id === selectedId ? 'true' : undefined}>
                          <span className="tag nt-card-kind">{KIND_LABEL[n.kind]}</span>
                          <span className="nt-card-title">{n.title}</span>
                          {n.excerpt && <span className="nt-card-excerpt muted">{n.excerpt}</span>}
                          <span className="nt-card-meta">
                            {n.tags.map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))}
                            {n.links.length > 0 && <span className="muted">{n.links.map((l) => l.name ?? l.ref).join(', ')}</span>}
                            {updatedLabel(n.updated_at) && <span className="muted">{updatedLabel(n.updated_at)}</span>}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </main>

      {section !== 'scene-notes' && !editor && openNote && (
        <Dialog label={openNote.title ?? 'Note'} onClose={handlers.onCloseNote ?? (() => {})} className="dialog-wide nt-note-dialog">
          <button type="button" className="btn nt-note-close" aria-label="Close note" onClick={handlers.onCloseNote}>
            ×
          </button>
          <NoteView bookId={bookId} note={openNote} sources={sources} handlers={handlers} />
        </Dialog>
      )}
    </div>
  );
}
