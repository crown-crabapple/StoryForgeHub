import { groupByTarget, outcomeText, sourceLabelOf, splitSuggestions } from './model.js';

/** One suggestion as a button in the sidebar: source and date, with the number of changes still waiting. */
function Item({ suggestion: s, selected, onSelect }) {
  return (
    <button type="button" className="codex-cat sg-side-item" aria-current={selected ? 'true' : undefined} onClick={() => onSelect?.(s.id)}>
      <span>
        {sourceLabelOf(s.source)} · {String(s.created).slice(0, 10)}
      </span>
      <span className="codex-cat-count" title={s.pending > 0 ? 'Changes waiting' : outcomeText(s)}>
        {s.pending > 0 ? s.pending : '✓'}
      </span>
    </button>
  );
}

/**
 * The "Suggestions" group of the Continuity tab's sidebar (M05-J06): every suggestion that still has a change waiting, grouped by the file it would change, and under
 * "Decided" the ones that are done (each with its outcome). Presentational.
 * @param {{ suggestions: any[], selectedId?: string | null, onSelect?: (id: string) => void }} props
 */
export function SuggestionsGroup({ suggestions, selectedId = null, onSelect }) {
  const { open, decided } = splitSuggestions(suggestions);
  const groups = groupByTarget(open);
  return (
    <section className="sg-group" aria-label="Suggestions">
      <h2 className="codex-sidebar-title cf-side-title">
        Suggestions {open.length > 0 && <span className="badge">{open.length}</span>}
      </h2>
      {open.length === 0 && <p className="muted sg-none">No pending suggestions.</p>}
      {groups.map((g) => (
        <div key={g.key} className="sg-target">
          <p className="sg-target-title">{g.title}</p>
          {g.items.map((s) => (
            <Item key={s.id} suggestion={s} selected={s.id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      ))}
      {decided.length > 0 && (
        <details className="sg-decided-list">
          <summary>Decided ({decided.length})</summary>
          {decided.map((s) => (
            <div key={s.id} className="sg-target">
              <p className="sg-target-title">{s.target_title ?? (s.target_path || 'New file')}</p>
              <Item suggestion={s} selected={s.id === selectedId} onSelect={onSelect} />
              <p className="muted sg-outcome">{outcomeText(s)}</p>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
