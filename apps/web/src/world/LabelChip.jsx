import { hasLabel, labelChoices, labelMap } from './model.js';

/**
 * A label as a small chip: a dot in the label's colour, then its name in the normal text colour (the colour is never the only cue). A label nothing defines is drawn
 * without a colour. `defs` is the answer's `labels` ([{ name, color, scope }]).
 * @param {{ name: string, defs?: { name: string, color: string | null }[] | null }} props
 */
export function LabelChip({ name, defs = null }) {
  const def = labelMap(defs).get(name.trim().toLowerCase());
  return (
    <span className="label-chip" data-label={name} style={def?.color ? { '--label': def.color } : undefined}>
      <span className="label-chip-dot" aria-hidden="true" />
      {name}
    </span>
  );
}

/** The chips of a document, as a list. @param {{ labels?: string[], defs?: any[] | null, label?: string }} props */
export function LabelChips({ labels = [], defs = null, label = 'Labels' }) {
  if (!labels || labels.length === 0) return null;
  return (
    <ul className="label-chips" aria-label={label}>
      {labels.map((n) => (
        <li key={n}>
          <LabelChip name={n} defs={defs} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The "Label" filter: a select of the defined labels (and any a document uses that nothing defines). Renders nothing when there is nothing to filter by.
 * @param {{ defs?: any[] | null, used?: string[][], value: string, onChange: (name: string) => void, id?: string }} props
 */
export function LabelFilter({ defs = null, used = [], value, onChange }) {
  const names = labelChoices(defs, used);
  if (names.length === 0) return null;
  return (
    <label className="toolbar-sort">
      Label
      <select name="label" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All labels</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

export { hasLabel };
