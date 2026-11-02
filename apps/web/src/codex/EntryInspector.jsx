import { ProseView } from '../ProseView.jsx';
import { Link } from '../router.jsx';
import { Avatar, StatusChip } from './CodexCard.jsx';
import { LinkedText } from './LinkedText.jsx';
import { PresenceBars } from './PresenceBars.jsx';
import { codexHref, factsOf, roleLabel, sceneHref, sceneRows } from './model.js';

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

/**
 * The right column for one entry: avatar, name, type and role; facts; aliases; each `##` section; presence by chapter; where it appears;
 * relationships; "Open in manuscript" (the first scene that links it explicitly). The buttons for Edit, Archive and so on appear only when
 * the page gives a handler for them. Presentational: `entry` is one entry of GET /codex/entries (or GET /entries/:id).
 * @param {{ bookId: string, entry: any | null, chapters?: { chapter: number, scene_ids?: string[] }[], types?: { type: string, name: string }[],
 *   resolve?: (ref: string) => { id: string } | null, onSelect?: (entryId: string) => void, onEdit?: () => void, onEditText?: () => void,
 *   onChangeSlug?: () => void, onArchive?: () => void, onRestore?: () => void }} props
 */
export function EntryInspector({ bookId, entry, chapters = [], types = [], resolve, onSelect, onEdit, onEditText, onChangeSlug, onArchive, onRestore }) {
  if (!entry) return <p className="muted">Select an entry to see its details.</p>;
  const facts = factsOf(entry.fields);
  const rows = sceneRows(entry.appears_in);
  const firstExplicit = rows.find((r) => r.kind === 'explicit');
  const typeName = types.find((t) => t.type === entry.type)?.name ?? entry.type;
  const subtitle = [typeName, entry.role].filter(Boolean).join(' · ') || roleLabel(entry, types);
  const related = entry.related ?? [];
  const problems = entry.problems ?? [];
  const sections = entry.sections ?? [];
  const hasActions = onEdit || onEditText || onChangeSlug || onArchive || onRestore;
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

      {facts.length > 0 && (
        <dl className="codex-facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value === '' ? <span className="muted">—</span> : <LinkedText text={f.value} bookId={bookId} resolve={resolve} />}</dd>
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
            {(s.markdown ?? s.text ?? '') === '' ? <p className="muted">Nothing written yet.</p> : <ProseView source={s.markdown ?? s.text} />}
          </div>
        </Section>
      ))}

      {chapters.length > 0 && !entry.archived && (
        <Section title="Presence by chapter">
          <PresenceBars name={entry.name} appearsIn={entry.appears_in ?? []} chapters={chapters} />
        </Section>
      )}

      {!entry.archived && (
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
      )}

      {related.length > 0 && (
        <Section title="Relationships">
          <ul className="codex-rels">
            {related.map((r) => (
              <Relation key={`${r.direction}-${r.id}-${r.as}`} bookId={bookId} rel={r} onSelect={onSelect} />
            ))}
          </ul>
        </Section>
      )}

      {problems.length > 0 && (
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
  );
}
