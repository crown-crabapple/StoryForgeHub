import { LabelChip } from '../world/LabelChip.jsx';
import { sharedBadge } from '../world/model.js';
import { blurbOf, chapterShort, explicitScenes, firstSeen, initialOf, roleLabel, scenesLabel, statusLabel } from './model.js';

/** The round avatar: the entry's image (when it has a usable one) or the initial of its name. @param {{ entry: any, size?: 'card' | 'large' }} props */
export function Avatar({ entry, size = 'card' }) {
  return (
    <span className={`codex-avatar codex-avatar-${size}`} aria-hidden="true">
      {entry.image_url ? <img src={entry.image_url} alt="" loading="lazy" /> : initialOf(entry.name)}
    </span>
  );
}

/** The small status chip ("Seed", "Sketch", "Canon", or "Archived"). @param {{ entry: any }} props */
export function StatusChip({ entry }) {
  const label = entry.archived ? 'Archived' : statusLabel(entry.status);
  return (
    <span className="codex-status" data-status={entry.archived ? 'archived' : (entry.status ?? 'none')}>
      {label}
    </span>
  );
}

/**
 * One card of the grid: avatar, name, role (or type), a one-line blurb, "First seen Ch N", "N scenes" and the status. The whole card is a
 * button that selects the entry (`aria-pressed`). Presentational.
 * @param {{ entry: any, chapters?: { chapter: number, scene_ids?: string[] }[], types?: { type: string, name: string }[], selected?: boolean,
 *   tabIndex?: number, onSelect?: (entry: any) => void, labelDefs?: any[] | null, pending?: number }} props
 *   `pending`: how many suggestions wait on the entry (a small badge in the card's head when above 0).
 *   A shared entry of the series carries a "Shared · <series title>" badge; its labels show as chips.
 */
export function CodexCard({ entry, chapters = [], types = [], selected = false, tabIndex = 0, onSelect, labelDefs = null, pending = 0 }) {
  const seen = firstSeen(entry, chapters);
  const scenes = explicitScenes(entry).length;
  return (
    <button type="button" className="codex-card" aria-pressed={selected ? 'true' : 'false'} tabIndex={tabIndex} data-entry-id={entry.id} onClick={() => onSelect?.(entry)}>
      <span className="codex-card-head">
        <Avatar entry={entry} />
        <span className="codex-card-id">
          <span className="codex-card-name">{entry.name}</span>
          <span className="codex-card-role">{roleLabel(entry, types)}</span>
        </span>
        {pending > 0 && (
          <span className="badge" aria-label={`${pending} pending ${pending === 1 ? 'suggestion' : 'suggestions'}`}>
            {pending}
          </span>
        )}
        <StatusChip entry={entry} />
      </span>
      <span className="codex-card-blurb">{blurbOf(entry.sections)}</span>
      {(entry.shared || (entry.labels ?? []).length > 0) && (
        <span className="codex-card-tags">
          {entry.shared && <span className="shared-badge">{sharedBadge(entry)}</span>}
          {(entry.labels ?? []).map((n) => (
            <LabelChip key={n} name={n} defs={labelDefs} />
          ))}
        </span>
      )}
      <span className="codex-card-foot">
        <span>{seen ? `First seen ${seen.label}` : 'Not seen yet'}</span>
        <span>{scenesLabel(scenes)}</span>
      </span>
    </button>
  );
}

export { chapterShort };
