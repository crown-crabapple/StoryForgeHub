// The forms of the Codex page. Each one only collects input and hands the request(s) to `onPreview`; the page then shows the dry-run
// diff and writes only when the author presses Apply.
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { ENTRY_STATUSES, coerceFieldValue, factsOf, fieldsPatch, linesOf, slugOf, statusLabel, typeWordOf } from './model.js';
import { fieldsRequest, newEntryRequests, newTypeRequest, slugRequest } from './requests.js';

const NEW_TYPE = '__new__';
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
 * New entry: type (or "New type…"), name, slug, status.
 * @param {{ bookId: string, types: { type: string, name: string, fields?: string[] }[], takenSlugs: Set<string>, defaultType?: string | null,
 *   onClose: () => void, onPreview: (title: string, requests: any[], then: { select: string }) => void }} props
 */
export function NewEntryDialog({ bookId, types, takenSlugs, defaultType = null, onClose, onPreview }) {
  const first = defaultType && types.some((t) => t.type === defaultType) ? defaultType : (types[0]?.type ?? NEW_TYPE);
  const [typeKey, setTypeKey] = useState(first);
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
    if (takenSlugs.has(shownSlug)) return setError(`The slug "${shownSlug}" is already used by another entry, thread or event.`);
    let newType = null;
    let type = typeKey;
    if (isNew) {
      if (typeName.trim() === '' || word === '') return setError('Give the new type a name made of letters, for example "Ship".');
      if (types.some((t) => t.type === word)) return setError(`The type "${word}" already exists. Choose it in the list instead.`);
      type = word;
      newType = { name: typeName.trim(), plural: plural.trim(), fields: linesOf(labels) };
    }
    setError(null);
    onPreview(isNew ? `New ${typeName.trim()} entry: ${name.trim()}` : `New entry: ${name.trim()}`, newEntryRequests(bookId, { type, name: name.trim(), slug: shownSlug, status, newType }), { select: shownSlug });
  }

  return (
    <Dialog label="New entry" onClose={onClose}>
      <h2>New entry</h2>
      <form onSubmit={submit}>
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
            <Row label="Default fields (one per line, optional)" hint="Every new entry of this type starts with these labels, empty.">
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
 * New type on its own (from the sidebar).
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
    setError(null);
    onPreview(`New type: ${name.trim()}`, [newTypeRequest(bookId, { type: word, name: name.trim(), plural: plural.trim(), fields: linesOf(labels) })]);
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
        <Row label="Default fields (one per line, optional)" hint="Every new entry of this type starts with these labels, empty.">
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
  };
}

/**
 * Edit fields: name, status, role, aliases, the fields grid and the relationships. Only what changed is sent.
 * @param {{ bookId: string, entry: any, entries: any[], onClose: () => void, onPreview: (title: string, requests: any[]) => void }} props
 */
export function EditFieldsDialog({ bookId, entry, entries, onClose, onPreview }) {
  const [before] = useState(() => editableOf(entry, entries));
  const [name, setName] = useState(before.name);
  const [status, setStatus] = useState(before.status);
  const [role, setRole] = useState(before.role);
  const [aliases, setAliases] = useState(before.aliases.join('\n'));
  const [rows, setRows] = useState(() => before.fields.map((f) => ({ key: nextKey(), label: f.label, text: String(f.value ?? ''), original: f.value })));
  const [rels, setRels] = useState(() => before.related.map((r) => ({ key: nextKey(), to: r.to, as: r.as ?? '' })));
  const [error, setError] = useState(null);
  const others = entries.filter((e) => !e.archived && e.id !== entry.id && e.slug);

  const patchRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const patchRel = (key, patch) => setRels((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function submit(e) {
    e.preventDefault();
    if (name.trim() === '') return setError('The name cannot be empty.');
    const labelsUsed = rows.map((r) => r.label.trim()).filter(Boolean);
    if (new Set(labelsUsed).size !== labelsUsed.length) return setError('Two fields have the same label.');
    if (rels.some((r) => r.to === '')) return setError('Choose who each relationship points to, or remove it.');
    const after = {
      name: name.trim(),
      status,
      role: role.trim(),
      aliases: linesOf(aliases),
      fields: rows.filter((r) => r.label.trim() !== '').map((r) => ({ label: r.label.trim(), value: coerceFieldValue(r.text, r.original) })),
      related: rels.map((r) => ({ to: r.to, ...(r.as.trim() ? { as: r.as.trim() } : {}) })),
    };
    const patch = fieldsPatch(before, after);
    if (Object.keys(patch).length === 0) return setError('Nothing was changed.');
    setError(null);
    onPreview(`Edit ${entry.name}`, [fieldsRequest(bookId, entry.id, patch)]);
  }

  return (
    <Dialog label={`Edit ${entry.name}`} onClose={onClose} className="codex-dialog">
      <h2>Edit {entry.name}</h2>
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
              <input type="text" className="form-input" aria-label={`Value of ${r.label || 'field'}`} placeholder="Value" value={r.text} onChange={(e) => patchRow(r.key, { text: e.target.value })} autoComplete="off" />
              <button type="button" className="btn row-button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn row-button" onClick={() => setRows((rs) => [...rs, { key: nextKey(), label: '', text: '', original: undefined }])}>
            Add field
          </button>
        </fieldset>

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
