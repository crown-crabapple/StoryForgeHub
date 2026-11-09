import { useRef, useState } from 'react';
import { ProseView } from '../ProseView.jsx';
import { Link } from '../router.jsx';
import { Avatar, StatusChip } from './CodexCard.jsx';
import { LinkedText } from './LinkedText.jsx';
import { LabelChips } from '../world/LabelChip.jsx';
import { SHARED_NOTICE, sharedBadge } from '../world/model.js';
import { PresenceBars } from './PresenceBars.jsx';
import { ResearchList } from '../notes/RailResearch.jsx';
import { codexHref, factsOf, nextTabIndex, roleLabel, sceneHref, sceneRows } from './model.js';

function Section({ title, children }) {
  return (
    <section className="codex-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** One relationship: out ("Tobin Reyes", "childhood friend") or in ("← carried by Brass Key"). Each is a button that selects that entry. */
function Relation({ bookId, rel, onSelect }) {
  const who = rel.name ?? rel.id;
  const out = rel.direction !== 'in';
  const label = out ? who : `← ${rel.as ? `${rel.as} ` : ''}${who}`;
  return (
    <li className="codex-rel">
      {onSelect ? (
        <button type="button" className="codex-rel-who" onClick={() => onSelect(rel.id)}>
          {label}
        </button>
      ) : (
        <Link className="codex-rel-who" to={codexHref(bookId, { entry: rel.id })}>
          {label}
        </Link>
      )}
      {out && <span className="codex-rel-how">{rel.as ?? 'related'}</span>}
    </li>
  );
}

const TAB_KEYS = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];

/**
 * The details pane for one entry. Always on top: avatar, name, type and role, the shared notice, labels, then a bar with "Open in manuscript"
 * (the first scene that links it explicitly) and the buttons for Edit, Archive and so on (only those the page gives a handler for). Below,
 * a tablist ("Entry sections") with one tabpanel each: Details (facts, aliases, each `##` section), Mentions (presence by chapter, where it
 * appears; not for archived entries), Research (when `research` is given; not for archived), Relations, and Needs review (only when there are
 * problems, with a count). All panels are rendered; inactive ones are `hidden`. The chosen tab persists across entries; a tab that the entry
 * does not have falls back to Details. Presentational: `entry` is one entry of GET /codex/entries (or GET /entries/:id).
 * @param {{ bookId: string, entry: any | null, chapters?: { chapter: number, scene_ids?: string[] }[], types?: { type: string, name: string }[],
 *   resolve?: (ref: string) => { id: string } | null, onSelect?: (entryId: string) => void, onEdit?: () => void, onEditText?: () => void,
 *   onChangeSlug?: () => void, onArchive?: () => void, onRestore?: () => void, research?: { id: string, title: string | null }[] | null,
 *   onMoveToSeries?: () => void, onCopyIntoBook?: () => void, labelDefs?: any[] | null, initialTab?: string, linkOf?: (ref: string) => { href: string, name?: string | null } | null, suggestions?: import('react').ReactNode }} props
 *   A shared entry shows its badge, the path of the series file and the notice that changes apply to every book of the series. `onMoveToSeries` is the menu entry
 *   "Move to series…" of a book's own entry, `onCopyIntoBook` "Copy into this book…" of a shared one.
 *   `initialTab`: the tab selected at first, one of 'details' (default), 'mentions', 'research', 'relations', 'needs-review'.
 *   `suggestions`: a node drawn below the tab panels (the page gives the "Suggestions" section for the entry when the suggestions module is on).
 *   `research` (M04-J04): the research notes whose `links` name the entry; when given (even empty) the inspector shows a "Research" tab.
 */
export function EntryInspector({ bookId, entry, chapters = [], types = [], resolve, onSelect, onEdit, onEditText, onChangeSlug, onArchive, onRestore, research = null, onMoveToSeries, onCopyIntoBook, labelDefs = null, initialTab, linkOf, suggestions = null }) {
  const [tab, setTab] = useState(initialTab ?? 'details');
  const tablistRef = useRef(null);
  if (!entry) return <p className="muted">Select an entry to see its details.</p>;
  const facts = factsOf(entry.fields);
  const rows = sceneRows(entry.appears_in);
  const firstExplicit = rows.find((r) => r.kind === 'explicit');
  const typeName = types.find((t) => t.type === entry.type)?.name ?? entry.type;
  const subtitle = [typeName, entry.role].filter(Boolean).join(' · ') || roleLabel(entry, types);
  const related = entry.related ?? [];
  const problems = entry.problems ?? [];
  const sections = entry.sections ?? [];
  const hasActions = onEdit || onEditText || onChangeSlug || onArchive || onRestore || onMoveToSeries || onCopyIntoBook;
  const tabs = [
    { key: 'details', label: 'Details' },
    ...(!entry.archived ? [{ key: 'mentions', label: 'Mentions' }] : []),
    ...(research !== null && !entry.archived ? [{ key: 'research', label: 'Research' }] : []),
    { key: 'relations', label: 'Relations' },
    ...(problems.length > 0 ? [{ key: 'needs-review', label: 'Needs review', count: problems.length }] : []),
  ];
  const active = tabs.some((t) => t.key === tab) ? tab : 'details';
  const onTabKeyDown = (e) => {
    if (!TAB_KEYS.includes(e.key)) return;
    const at = tabs.findIndex((t) => t.key === active);
    const to = nextTabIndex(at, e.key, tabs.length);
    e.preventDefault();
    setTab(tabs[to].key);
    tablistRef.current?.querySelectorAll('[role="tab"]')[to]?.focus();
  };
  return (
    <div className="codex-inspector">
      <div className="codex-detail-head">
        <Avatar entry={entry} size="large" />
        <div className="codex-detail-id">
          <h2>{entry.name}</h2>
          <span className="codex-detail-sub">{subtitle}</span>
          <StatusChip entry={entry} />
        </div>
      </div>

      {entry.shared && (
        <div className="shared-info">
          <span className="shared-badge">{sharedBadge(entry)}</span>
          <p className="muted shared-path">
            Series file: <code>{entry.path}</code>
          </p>
          <p className="muted" role="note">
            {SHARED_NOTICE}
          </p>
        </div>
      )}
      <LabelChips labels={entry.labels} defs={labelDefs} />

      {((firstExplicit && !entry.archived) || hasActions) && (
        <div className="codex-detail-bar">
          {firstExplicit && !entry.archived && (
            <Link className="btn codex-open" to={sceneHref(bookId, firstExplicit.scene_id)}>
              Open in manuscript
            </Link>
          )}
          {hasActions && (
            <div className="codex-actions">
              {onEdit && (
                <button type="button" className="btn" onClick={onEdit}>
                  Edit fields…
                </button>
              )}
              {onEditText && (
                <button type="button" className="btn" onClick={onEditText}>
                  Edit text…
                </button>
              )}
              {onChangeSlug && (
                <button type="button" className="btn" onClick={onChangeSlug}>
                  Change slug…
                </button>
              )}
              {onMoveToSeries && (
                <button type="button" className="btn" onClick={onMoveToSeries}>
                  Move to series…
                </button>
              )}
              {onCopyIntoBook && (
                <button type="button" className="btn" onClick={onCopyIntoBook}>
                  Copy into this book…
                </button>
              )}
              {onArchive && (
                <button type="button" className="btn" onClick={onArchive}>
                  Archive…
                </button>
              )}
              {onRestore && (
                <button type="button" className="btn" onClick={onRestore}>
                  Restore…
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div role="tablist" aria-label="Entry sections" className="entry-tabs" ref={tablistRef} onKeyDown={onTabKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`entry-tab-${t.key}`}
            aria-controls={`entry-panel-${t.key}`}
            aria-selected={active === t.key}
            tabIndex={active === t.key ? 0 : -1}
            className="entry-tab"
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count !== undefined && <span className="entry-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" id={`entry-panel-${t.key}`} aria-labelledby={`entry-tab-${t.key}`} className="entry-panel" hidden={active !== t.key}>
          {t.key === 'details' && (
            <>
              {facts.length > 0 && (
                <dl className="codex-facts">
                  {facts.map((f) => (
                    <div key={f.label}>
                      <dt>{f.label}</dt>
                      <dd>{f.value === '' ? <span className="muted">—</span> : <LinkedText text={f.value} bookId={bookId} resolve={resolve} linkOf={linkOf} />}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {(entry.aliases ?? []).length > 0 && (
                <Section title="Also called">
                  <p className="codex-aliases">{entry.aliases.join(', ')}</p>
                </Section>
              )}
              {sections.map((s, i) => (
                <Section key={`${s.heading}-${i}`} title={s.heading}>
                  <div className="codex-section-text">
                    {(s.markdown ?? s.text ?? '') === '' ? <p className="muted">Nothing written yet.</p> : <ProseView source={s.markdown ?? s.text} linkOf={linkOf} />}
                  </div>
                </Section>
              ))}
            </>
          )}
          {t.key === 'mentions' && (
            <>
              {chapters.length > 0 && (
                <Section title="Presence by chapter">
                  <PresenceBars name={entry.name} appearsIn={entry.appears_in ?? []} chapters={chapters} />
                </Section>
              )}
              <Section title="Appears in">
                {rows.length === 0 ? (
                  <p className="muted">Not linked from any scene yet.</p>
                ) : (
                  <ul className="codex-appears">
                    {rows.map((r) => (
                      <li key={r.scene_id}>
                        <Link to={sceneHref(bookId, r.scene_id)}>{r.title}</Link>
                        {r.kind === 'inferred' && <span className="tag">mentioned</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
          {t.key === 'research' && (
            <Section title="Research">
              <ResearchList bookId={bookId} notes={research} empty="No research notes link to this entry." />
            </Section>
          )}
          {t.key === 'relations' &&
            (related.length > 0 ? (
              <Section title="Relationships">
                <ul className="codex-rels">
                  {related.map((r) => (
                    <Relation key={`${r.direction}-${r.id}-${r.as}`} bookId={bookId} rel={r} onSelect={onSelect} />
                  ))}
                </ul>
              </Section>
            ) : (
              <p className="muted">No relationships yet.</p>
            ))}
          {t.key === 'needs-review' && (
            <Section title="Needs review">
              <ul className="codex-problems">
                {problems.map((p, i) => (
                  <li key={`${p.code}-${p.location}-${i}`} className={`diag-${p.severity}`}>
                    <strong>{p.code}</strong> {p.message}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      ))}
      {suggestions}
    </div>
  );
}
