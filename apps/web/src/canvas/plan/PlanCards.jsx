// The bodies of the story cards that show planner data (M10 C3): story plan, synopsis, arc, relationship, clue, beat and structure.
// Read-only; the data comes from usePlanData through planItemFor, and a card whose item is not loaded still shows the title and summary the server gave.
import { ARC_TYPES } from '../../planner/requests.js';
import { arcName, relationshipName } from '../../planner/model.js';
import { kindLabel } from '../../planner/clues.js';
import { targetText } from '../../planner/synopsis.js';
import { chapterOf, chaptersText, excerpt, planItemFor } from './selectors.js';

const STORY_ROWS = [
  ['logline', 'Logline'],
  ['premise', 'Premise'],
  ['theme_question', 'Theme question'],
  ['central_conflict', 'Central conflict'],
  ['stakes', 'Stakes'],
];

/** A label and its text; nothing when the text is empty. */
function Row({ label, text }) {
  if (!text) return null;
  return (
    <p className="cv-plan-row">
      <span className="cv-plan-label">{label}</span> {text}
    </p>
  );
}

const STATE_LABEL = { open: 'Open', done: 'Done', omitted: 'Omitted' };

/**
 * @param {{ refInfo: { kind: string, id: string, title?: string | null, summary?: string | null }, plan: any }} props
 */
export function PlanCardBody({ refInfo, plan }) {
  const item = planItemFor(plan, refInfo);
  const kind = refInfo.kind;
  const title = refInfo.title;
  const fallback = !item && refInfo.summary ? <p className="cv-story-summary">{refInfo.summary}</p> : null;

  if (kind === 'story-plan') {
    const f = item?.fields ?? {};
    return (
      <div className="cv-story cv-plan cv-plan-story-plan">
        <p className="cv-meta">Story plan</p>
        {STORY_ROWS.map(([key, label]) => (
          <Row key={key} label={label} text={f[key]} />
        ))}
        {item && STORY_ROWS.every(([key]) => !f[key]) && <p className="cv-empty">Nothing written yet.</p>}
        {fallback}
      </div>
    );
  }
  if (kind === 'synopsis') {
    const text = excerpt(item?.body ?? refInfo.summary, 200);
    return (
      <div className="cv-story cv-plan cv-plan-synopsis">
        <p className="cv-meta">
          {title ?? 'Synopsis'}
          {item?.stale && <span className="cv-chip cv-chip-warn">Stale</span>}
        </p>
        {text ? <p className="cv-story-summary">{text}</p> : <p className="cv-empty">Nothing written yet.</p>}
        {typeof item?.words === 'number' && <p className="cv-plan-line">{targetText(item.words, item.target_words)}</p>}
      </div>
    );
  }
  if (kind === 'arc') {
    const f = item?.fields ?? {};
    const miles = item?.milestones ?? [];
    return (
      <div className="cv-story cv-plan cv-plan-arc">
        <p className="cv-meta">{`Arc · ${item ? arcName(item) : (title ?? 'Arc')}`}</p>
        {item?.arc_type && <p className="cv-plan-line">{ARC_TYPES.find((t) => t.value === item.arc_type)?.label ?? item.arc_type}</p>}
        <Row label="Want" text={f.want} />
        <Row label="Need" text={f.need} />
        {item && (
          <p className="cv-plan-dots" role="img" aria-label={`${miles.length} ${miles.length === 1 ? 'milestone' : 'milestones'}`}>
            {miles.map((m, i) => (
              <span key={m.index ?? i} className="cv-plan-dot" aria-hidden="true" />
            ))}
            {miles.length === 0 && <span className="cv-empty">No milestones yet</span>}
          </p>
        )}
        {fallback}
      </div>
    );
  }
  if (kind === 'relationship') {
    const n = (item?.developments ?? []).length;
    return (
      <div className="cv-story cv-plan cv-plan-relationship">
        <p className="cv-meta">Relationship</p>
        <p className="cv-story-title">{item ? relationshipName(item) : (title ?? 'Relationship')}</p>
        {item && (item.baseline || item.end_state) && (
          <p className="cv-plan-line">
            {item.baseline || '…'} → {item.end_state || '…'}
          </p>
        )}
        {item && <p className="cv-plan-line">{`${n} ${n === 1 ? 'development' : 'developments'}`}</p>}
        {fallback}
      </div>
    );
  }
  if (kind === 'clue') {
    const chapter = (s) => chapterOf(plan?.scenes, s.id) ?? null;
    const planted = chaptersText((item?.planted ?? []).map(chapter));
    const revealedAt = item?.revealed ? chaptersText([chapter(item.revealed)]) : '';
    const chip = item?.red_herring ? 'Red herring' : kindLabel(item?.kind ?? 'clue');
    return (
      <div className="cv-story cv-plan cv-plan-clue">
        <p className="cv-meta">
          <span className="cv-chip">{item ? chip : 'Clue'}</span>
        </p>
        <p className="cv-story-title">{item?.fact ?? title ?? 'Clue'}</p>
        {item && (
          <p className="cv-plan-line">
            {[planted ? `Planted ${planted}` : '', item.revealed ? `Revealed${revealedAt ? ` ${revealedAt}` : ''}` : 'Not revealed yet'].filter(Boolean).join(' · ')}
          </p>
        )}
        {fallback}
      </div>
    );
  }
  if (kind === 'beat' || kind === 'structure') {
    const state = item?.state;
    return (
      <div className="cv-story cv-plan cv-plan-beat">
        <p className="cv-meta">
          {kind === 'beat' ? `Beat${item?.structure?.name ? ` · ${item.structure.name}` : ''}` : 'Structure'}
          {kind === 'beat' && STATE_LABEL[state ?? 'open'] && <span className="cv-chip">{STATE_LABEL[state ?? 'open']}</span>}
        </p>
        <p className="cv-story-title">{item?.name ?? title ?? (kind === 'beat' ? 'Beat' : 'Structure')}</p>
        {kind === 'beat' && item?.position && <p className="cv-plan-line">{item.position}</p>}
        {kind === 'beat' && item?.question && <p className="cv-story-summary">{item.question}</p>}
        {kind === 'structure' && item && (
          <p className="cv-plan-line">
            {`${item.counts?.beats ?? (item.beats ?? []).length} beats${item.primary ? ' · Primary' : ''}`}
          </p>
        )}
        {fallback}
      </div>
    );
  }
  return null;
}
