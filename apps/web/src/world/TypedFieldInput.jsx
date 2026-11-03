import { useId, useState } from 'react';
import { LinkPicker } from '../editor/LinkPicker.jsx';
import { coerceTyped, fitsKind, parseList, w312Text } from './model.js';

/** The editor of a list field: one input per item, Add and Remove. Empty items are dropped from the value, so the author can add a blank one and fill it. */
function ListEditor({ label, value, onChange }) {
  const [items, setItems] = useState(() => {
    const list = parseList(value);
    return list.length > 0 ? list : [];
  });
  const push = (next) => {
    setItems(next);
    onChange(next.map((s) => s.trim()).filter(Boolean).join('\n'));
  };
  return (
    <div className="list-editor" role="group" aria-label={`${label} (list)`}>
      {items.length === 0 && <p className="muted list-empty">No items yet.</p>}
      {items.map((item, i) => (
        <div className="form-line" key={i}>
          <input type="text" className="form-input" aria-label={`${label} item ${i + 1}`} value={item} onChange={(e) => push(items.map((x, j) => (j === i ? e.target.value : x)))} autoComplete="off" />
          <button type="button" className="btn row-button" aria-label={`Remove ${label} item ${i + 1}`} onClick={() => push(items.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn row-button" onClick={() => setItems([...items, ''])}>
        Add item
      </button>
    </div>
  );
}

/**
 * The input of one field of an entry, drawn by the kind its type declares (contract M07-J01 section 4): number input, date input, choice select, link picker, list
 * editor, or plain text. A value that does not fit shows the W312 text under the input; saving is still allowed.
 * @param {{ label: string, def: { kind: string, choices: string[] } | null, text: string, original?: unknown, onChange: (text: string) => void, bookId?: string | null }} props
 *   `text` is the value as typed (a list is one item per line); `original` is the value the file has (it keeps its type while the text is unchanged).
 */
export function TypedFieldInput({ label, def, text, original, onChange, bookId = null }) {
  const id = useId();
  const [picking, setPicking] = useState(false);
  const kind = def?.kind ?? 'text';
  const value = coerceTyped(kind, text, original);
  const fits = fitsKind(kind, value, def?.choices ?? []);
  const warn = def && !fits ? `${w312Text(label, kind)} (W312). You can still save it.` : null;
  const common = { 'aria-label': `Value of ${label}`, 'aria-describedby': warn ? `${id}-w` : undefined, 'aria-invalid': warn ? 'true' : undefined };
  let input;
  if (kind === 'list') input = <ListEditor label={label} value={text} onChange={onChange} />;
  else if (kind === 'choice') {
    const choices = def?.choices ?? [];
    input = (
      <select className="form-select" value={text} onChange={(e) => onChange(e.target.value)} {...common}>
        <option value="">Choose…</option>
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        {text !== '' && !choices.includes(text) && <option value={text}>{`${text} (not a choice)`}</option>}
      </select>
    );
  } else if (kind === 'number' && (text === '' || Number.isFinite(Number(text)))) {
    input = <input type="number" step="any" className="form-input" value={text} onChange={(e) => onChange(e.target.value)} {...common} />;
  } else if (kind === 'date' && (text === '' || /^\d{4}-\d{2}-\d{2}$/.test(text))) {
    input = <input type="date" className="form-input" value={text} onChange={(e) => onChange(e.target.value)} {...common} />;
  } else if (kind === 'link') {
    input = (
      <span className="link-field">
        <input type="text" className="form-input" placeholder="[[slug]]" value={text} onChange={(e) => onChange(e.target.value)} autoComplete="off" {...common} />
        <button type="button" className="btn row-button" aria-label={`Pick a link for ${label}`} onClick={() => setPicking(true)}>
          Pick…
        </button>
        {picking && (
          <LinkPicker
            bookId={bookId}
            objects={null}
            selectedText=""
            onPick={(ref) => {
              setPicking(false);
              onChange(`[[${ref}]]`);
            }}
            onClose={() => setPicking(false)}
          />
        )}
      </span>
    );
  } else input = <input type="text" className="form-input" placeholder="Value" value={text} onChange={(e) => onChange(e.target.value)} autoComplete="off" {...common} />;
  return (
    <div className="typed-field" data-kind={kind}>
      {input}
      {warn && (
        <p id={`${id}-w`} className="field-warning" data-code="W312">
          {warn}
        </p>
      )}
    </div>
  );
}
