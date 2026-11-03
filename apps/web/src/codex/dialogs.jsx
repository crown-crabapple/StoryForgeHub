// The forms of the Codex page. Each one only collects input and hands the request(s) to `onPreview`; the page then shows the dry-run
// diff and writes only when the author presses Apply.
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { TypedFieldInput } from '../world/TypedFieldInput.jsx';
import { SHARED_NOTICE, coerceTyped, fieldDef, parseFieldLine, sharedBadge } from '../world/model.js';
import { ENTRY_STATUSES, factsOf, fieldsPatch, linesOf, slugOf, statusLabel, typeWordOf } from './model.js';
import { fieldsRequest, newEntryRequests, newTypeRequest, slugRequest } from './requests.js';

const NEW_TYPE = '__new__';
const FIELD_LINES_HINT = 'Every new entry of this type starts with these labels, empty. Add | kind to type a field: Tonnage | number, Launched | date, Home port | link, Cargoes | list, Rig | choice | sloop, ketch.';

/** The lines of a "Default fields" box as a type's fields: labels, or typed items. @param {string} text @returns {{ fields: (string | { label: string, kind: string, choices?: string[] })[], error?: undefined } | { error: string, fields?: undefined }} */
function parseFieldLines(text) {
  const fields = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const r = parseFieldLine(line);
    if (r.error) return { error: r.error };
    if (!fields.some((f) => (typeof f === 'string' ? f : f.label) === (typeof r.field === 'string' ? r.field : r.field.label))) fields.push(r.field);
  }
  return { fields };
}
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function Row({ label, hint, error, children }) {
  return (
    <div className="form-row">
      <label>
        <span className="form-label">{label}</span>
        {children}
      </label>
      {hint && <p className="muted form-hint">{hint}</p>}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** A select styled like the other inputs. */
function Select({ value, onChange, children, ...rest }) {
  return (
    <select className="form-select" value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {children}
    </select>
  );
}

/**
 * New entry: where (this book, or the series when the book is in one), type (or "New type…"), name, slug, status. A new type's default fields are one per line:
 * a plain label, or `Label | kind` / `Label | choice | a, b` for a typed field.
 * @param {{ bookId: string, types: { type: string, name: string, fields?: string[] }[], takenSlugs: Set<string>, defaultType?: string | null,
 *   series?: { slug: string, title?: string | null } | null, sharedSlugs?: Set<string>,
 *   onClose: () => void, onPreview: (title: string, requests: any[], then: { select: string, where?: string }) => void }} props
 *   `series` is the book's series (the "Where" choice shows only then); `sharedSlugs` are the slugs the series' shared entries use.
 */
export function NewEntryDialog({ bookId, types, takenSlugs, defaultType = null, series = null, sharedSlugs = new Set(), onClose, onPreview }) {
  const first = defaultType && types.some((t) => t.type === defaultType) ? defaultType : (types[0]?.type ?? NEW_TYPE);
  const [typeKey, setTypeKey] = useState(first);
  const [where, setWhere] = useState('book');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState('seed');
  const [typeName, setTypeName] = useState('');
  const [plural, setPlural] = useState('');
  const [labels, setLabels] = useState('');
  const [error, setError] = useState(null);
  const isNew = typeKey === NEW_TYPE;
  const shownSlug = slugTouched ? slug : slugOf(name);
  const word = typeWordOf(typeName);

  function submit(e) {
    e.preventDefault();
    if (name.trim() === '') return setError('Give the entry a name.');
    if (shownSlug === '') return setError('The name has no letters or digits to make a slug from. Type a slug.');
    if (!SLUG_RE.test(shownSlug) || shownSlug.length > 60) return setError('The slug can use lower-case letters, digits and single hyphens (up to 60 characters).');
    if ((where === 'series' ? sharedSlugs : takenSlugs).has(shownSlug)) {
      return setError(where === 'series' ? `The series already has an entry with the slug "${shownSlug}".` : `The slug "${shownSlug}" is already used by another entry, thread or event.`);
    }
    let newType = null;
    let type = typeKey;
    if (isNew) {
      if (typeName.trim() === '' || word === '') return setError('Give the new type a name made of letters, for example "Ship".');
      if (types.some((t) => t.type === word)) return setError(`The type "${word}" already exists. Choose it in the list instead.`);
      type = word;
      const parsed = parseFieldLines(labels);
      if (parsed.error) return setError(parsed.error);
      newType = { name: typeName.trim(), plural: plural.trim(), fields: parsed.fields };
    }
    setError(null);
    const title = isNew ? `New ${typeName.trim()} entry: ${name.trim()}` : `New entry: ${name.trim()}`;
    onPreview(where === 'series' ? `${title} (shared with the series)` : title, newEntryRequests(bookId, { type, name: name.trim(), slug: shownSlug, status, where, newType }), { select: shownSlug, where });
  }

  return (
    <Dialog label="New entry" onClose={onClose}>
      <h2>New entry</h2>
      <form onSubmit={submit}>
        {series && (
          <fieldset className="form-group where-choice">
            <legend className="form-label">Where</legend>
            <label className="form-radio">
              <input type="radio" name="where" value="book" checked={where === 'book'} onChange={() => setWhere('book')} /> This book
            </label>
            <label className="form-radio">
              <input type="radio" name="where" value="series" checked={where === 'series'} onChange={() => setWhere('series')} /> Series (shared): {series.title ?? series.slug}
            </label>
            {where === 'series' && (
              <p className="muted form-hint" role="note">
                Every book in the series will see this entry. {SHARED_NOTICE}
              </p>
            )}
          </fieldset>
        )}
        <Row label="Type">
          <Select value={typeKey} onChange={setTypeKey}>
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.name}
              </option>
            ))}
            <option value={NEW_TYPE}>New type…</option>
          </Select>
        </Row>
        {isNew && (
          <>
            <Row label="Type name" hint="One word of letters, such as Ship or Spell. It becomes the type and the folder codex/<type>s.">
              <input type="text" className="form-input" value={typeName} onChange={(e) => setTypeName(e.target.value)} autoComplete="off" />
            </Row>
            <Row label="Plural (optional)">
              <input type="text" className="form-input" value={plural} onChange={(e) => setPlural(e.target.value)} placeholder={typeName ? `${typeName}s` : ''} autoComplete="off" />
            </Row>
            <Row label="Default fields (one per line, optional)" hint={FIELD_LINES_HINT}>
              <textarea className="form-input" rows={3} value={labels} onChange={(e) => setLabels(e.target.value)} />
            </Row>
          </>
        )}
        <Row label="Name">
          <input type="text" className="form-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
        </Row>
        <Row label="Slug" hint="The key links use: [[slug]]. It does not change when you rename the entry.">
          <input
            type="text"
            className="form-input"
            value={shownSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            autoComplete="off"
          />
        </Row>
        <Row label="Status">
          <Select value={status} onChange={setStatus}>
            {ENTRY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Row>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * New type on its own (from the sidebar). Default fields are one per line; `Label | kind` types a field (see FIELD_LINES_HINT).
 * @param {{ bookId: string, types: { type: string }[], onClose: () => void, onPreview: (title: string, requests: any[]) => void }} props
 */
export function NewTypeDialog({ bookId, types, onClose, onPreview }) {
  const [name, setName] = useState('');
  const [plural, setPlural] = useState('');
  const [labels, setLabels] = useState('');
  const [error, setError] = useState(null);
  const word = typeWordOf(name);
  function submit(e) {
    e.preventDefault();
    if (name.trim() === '' || word === '') return setError('Give the type a name made of letters, for example "Ship".');
    if (types.some((t) => t.type === word)) return setError(`The type "${word}" already exists.`);
    const parsed = parseFieldLines(labels);
    if (parsed.error) return setError(parsed.error);
    setError(null);
    onPreview(`New type: ${name.trim()}`, [newTypeRequest(bookId, { type: word, name: name.trim(), plural: plural.trim(), fields: parsed.fields })]);
  }
  return (
    <Dialog label="New type" onClose={onClose}>
      <h2>New type</h2>
      <form onSubmit={submit}>
        <Row label="Name" hint="Singular, one word of letters, such as Ship or Spell.">
          <input type="text" className="form-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
        </Row>
        <Row label="Plural (optional)">
          <input type="text" className="form-input" value={plural} onChange={(e) => setPlural(e.target.value)} placeholder={name ? `${name}s` : ''} autoComplete="off" />
        </Row>
        <Row label="Default fields (one per line, optional)" hint={FIELD_LINES_HINT}>
          <textarea className="form-input" rows={3} value={labels} onChange={(e) => setLabels(e.target.value)} />
        </Row>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}

let rowKey = 0;
const nextKey = () => `r${rowKey++}`;

/** What the form starts from, and what `fieldsPatch` compares against. @param {any} entry @param {any[]} entries */
export function editableOf(entry, entries) {
  const slugById = new Map(entries.map((e) => [e.id, e.slug]));
  return {
    name: entry.name ?? '',
    status: entry.status ?? 'seed',
    role: entry.role ?? '',
    aliases: entry.aliases ?? [],
    fields: factsOf(entry.fields).map((f) => ({ label: f.label, value: f.raw })),
    related: (entry.related ?? []).filter((r) => r.direction === 'out').map((r) => ({ to: slugById.get(r.id) ?? r.id, ...(r.as ? { as: r.as } : {}) })),
    labels: entry.labels ?? [],
  };
}

/** A field value as the text the form shows: a list is one item per line. @param {unknown} v */
const textOfValue = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? ''));

/**
 * Edit fields: name, status, role, aliases, the fields grid and the relationships. Only what changed is sent.
 * Fields the entry's type declares are drawn by their kind (number, date, choice, link, list); a value that does not fit shows W312 under its input and can
 * still be saved. A shared entry says first that the change applies to every book in the series; its relationships offer only the series' shared entries.
 * @param {{ bookId: string, entry: any, entries: any[], types?: any[], labelDefs?: any[] | null, onClose: () => void, onPreview: (title: string, requests: any[]) => void }} props
 */
export function EditFieldsDialog({ bookId, entry, entries, types = [], labelDefs = null, onClose, onPreview }) {
  const [before] = useState(() => editableOf(entry, entries));
  const declared = (types.find((t) => t.type === entry.type)?.field_defs ?? []).map((d) => d.label);
  const [name, setName] = useState(before.name);
  const [status, setStatus] = useState(before.status);
  const [role, setRole] = useState(before.role);
  const [aliases, setAliases] = useState(before.aliases.join('\n'));
  const [rows, setRows] = useState(() => [
    ...before.fields.map((f) => ({ key: nextKey(), label: f.label, text: textOfValue(f.value), original: f.value })),
    // a field the type declares and the entry does not have yet is offered empty; it is written only when filled in
    ...declared.filter((l) => !before.fields.some((f) => f.label === l)).map((l) => ({ key: nextKey(), label: l, text: '', original: undefined, offered: true })),
  ]);
  const [labels, setLabels] = useState(() => before.labels);
  const [rels, setRels] = useState(() => before.related.map((r) => ({ key: nextKey(), to: r.to, as: r.as ?? '' })));
  const [error, setError] = useState(null);
  const others = entries.filter((e) => !e.archived && e.id !== entry.id && e.slug && (!entry.shared || e.shared));
  const labelNames = [...(labelDefs ?? []).map((d) => d.name), ...before.labels.filter((n) => !(labelDefs ?? []).some((d) => d.name.toLowerCase() === n.toLowerCase()))];

  const patchRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const patchRel = (key, patch) => setRels((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function submit(e) {
    e.preventDefault();
    if (name.trim() === '') return setError('The name cannot be empty.');
    const kept = rows.filter((r) => !(r.offered && r.text.trim() === ''));
    const labelsUsed = kept.map((r) => r.label.trim()).filter(Boolean);
    if (new Set(labelsUsed).size !== labelsUsed.length) return setError('Two fields have the same label.');
    if (rels.some((r) => r.to === '')) return setError('Choose who each relationship points to, or remove it.');
    const after = {
      name: name.trim(),
      status,
      role: role.trim(),
      aliases: linesOf(aliases),
      fields: kept.filter((r) => r.label.trim() !== '').map((r) => ({ label: r.label.trim(), value: coerceTyped(fieldDef(types, entry.type, r.label.trim())?.kind, r.text, r.original) })),
      related: rels.map((r) => ({ to: r.to, ...(r.as.trim() ? { as: r.as.trim() } : {}) })),
      labels,
    };
    const patch = fieldsPatch(before, after);
    if (Object.keys(patch).length === 0) return setError('Nothing was changed.');
    setError(null);
    onPreview(`Edit ${entry.name}`, [fieldsRequest(bookId, entry.id, patch)]);
  }

  return (
    <Dialog label={`Edit ${entry.name}`} onClose={onClose} className="codex-dialog">
      <h2>Edit {entry.name}</h2>
      {entry.shared && (
        <p className="shared-notice" role="note">
          <span className="shared-badge">{sharedBadge(entry)}</span> {SHARED_NOTICE}
        </p>
      )}
      <form onSubmit={submit}>
        <Row label="Name" hint="Renaming does not change the slug, so links keep working.">
          <input type="text" className="form-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
        </Row>
        <div className="form-pair">
          <Row label="Status">
            <Select value={status} onChange={setStatus}>
              {ENTRY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Role">
            <input type="text" className="form-input" value={role} onChange={(e) => setRole(e.target.value)} autoComplete="off" />
          </Row>
        </div>
        <Row label="Aliases (one per line)" hint="Other names the text uses; they help find mentions.">
          <textarea className="form-input" rows={2} value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Row>

        <fieldset className="form-group">
          <legend className="form-label">Fields</legend>
          {rows.map((r) => (
            <div className="form-line" key={r.key}>
              <input type="text" className="form-input" aria-label="Field label" placeholder="Label" value={r.label} onChange={(e) => patchRow(r.key, { label: e.target.value })} autoComplete="off" />
              <TypedFieldInput label={r.label || 'field'} def={fieldDef(types, entry.type, r.label.trim())} text={r.text} original={r.original} onChange={(text) => patchRow(r.key, { text })} bookId={bookId} />
              <button type="button" className="btn row-button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn row-button" onClick={() => setRows((rs) => [...rs, { key: nextKey(), label: '', text: '', original: undefined }])}>
            Add field
          </button>
        </fieldset>

        {labelNames.length > 0 && (
          <fieldset className="form-group">
            <legend className="form-label">Labels</legend>
            <div className="label-checks">
              {labelNames.map((n) => (
                <label key={n} className="form-radio">
                  <input
                    type="checkbox"
                    checked={labels.some((l) => l.toLowerCase() === n.toLowerCase())}
                    onChange={(e) => setLabels((ls) => (e.target.checked ? [...ls, n] : ls.filter((l) => l.toLowerCase() !== n.toLowerCase())))}
                  />{' '}
                  {n}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="form-group">
          <legend className="form-label">Relationships</legend>
          {rels.map((r) => (
            <div className="form-line" key={r.key}>
              <select className="form-select" aria-label="Related entry" value={r.to} onChange={(e) => patchRel(r.key, { to: e.target.value })}>
                <option value="">Choose an entry…</option>
                {others.map((o) => (
                  <option key={o.id} value={o.slug}>
                    {o.name}
                  </option>
                ))}
                {r.to !== '' && !others.some((o) => o.slug === r.to) && <option value={r.to}>{r.to}</option>}
              </select>
              <input type="text" className="form-input" aria-label="How they are related" placeholder="as (for example aunt)" value={r.as} onChange={(e) => patchRel(r.key, { as: e.target.value })} autoComplete="off" />
              <button type="button" className="btn row-button" onClick={() => setRels((rs) => rs.filter((x) => x.key !== r.key))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn row-button" onClick={() => setRels((rs) => [...rs, { key: nextKey(), to: '', as: '' }])}>
            Add relationship
          </button>
        </fieldset>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Change slug: the old slug is kept in previous_slugs, so links that use it still work.
 * @param {{ bookId: string, entry: any, takenSlugs: Set<string>, onClose: () => void, onPreview: (title: string, requests: any[], then: { select: string }) => void }} props
 */
export function ChangeSlugDialog({ bookId, entry, takenSlugs, onClose, onPreview }) {
  const [slug, setSlug] = useState(entry.slug ?? '');
  const [error, setError] = useState(null);
  function submit(e) {
    e.preventDefault();
    if (slug === entry.slug) return setError('That is the current slug.');
    if (!SLUG_RE.test(slug) || slug.length > 60) return setError('The slug can use lower-case letters, digits and single hyphens (up to 60 characters).');
    if (takenSlugs.has(slug)) return setError(`The slug "${slug}" is already used by another entry, thread or event.`);
    setError(null);
    onPreview(`Change the slug of ${entry.name}`, [slugRequest(bookId, entry.id, slug)], { select: slug });
  }
  return (
    <Dialog label={`Change the slug of ${entry.name}`} onClose={onClose}>
      <h2>Change slug</h2>
      <form onSubmit={submit}>
        <Row label="New slug" hint={`The current slug "${entry.slug}" is kept as a previous slug, so existing [[links]] still work. StoryForge warns (W301) where old links remain so you can update them.`}>
          <input type="text" className="form-input" value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" required />
        </Row>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}
