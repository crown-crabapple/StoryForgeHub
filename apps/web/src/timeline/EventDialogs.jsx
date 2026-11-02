// The forms of the Timeline page. Each one only collects input and hands it to `onSubmit(values)`, which resolves to { error } (the form stays open and shows it) or
// { close: true }; the page builds the request, shows the dry-run diff and writes only when the author presses Apply.
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { slugify } from '../structure/helpers.js';
import { defaultOrder } from './model.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

function Row({ label, hint, children }) {
  return (
    <div className="form-row">
      <label>
        <span className="form-label">{label}</span>
        {children}
      </label>
      {hint && <p className="muted form-hint">{hint}</p>}
    </div>
  );
}

function useSubmit(onSubmit, onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run(values) {
    setBusy(true);
    setError(null);
    const r = await onSubmit(values);
    setBusy(false);
    if (r?.error) setError(r.error);
    else onClose();
  }
  return { busy, error, run, setError };
}

/** Checkboxes for a list of codex entries; a reference the book does not know (written by hand) stays in the list so it is kept. */
function RefPicker({ legend, entries, value, onChange }) {
  const known = new Set(entries.flatMap((e) => [e.slug, e.id]));
  const odd = value.filter((v) => !known.has(v));
  const has = (e) => value.includes(e.slug) || value.includes(e.id);
  const toggle = (e) => {
    if (has(e)) onChange(value.filter((v) => v !== e.slug && v !== e.id));
    else onChange([...value, e.slug ?? e.id]);
  };
  return (
    <fieldset className="tl-picker">
      <legend>{legend}</legend>
      {entries.length === 0 && odd.length === 0 && <p className="muted">None in the Codex yet.</p>}
      {entries.map((e) => (
        <label key={e.id} className="form-check">
          <input type="checkbox" checked={has(e)} onChange={() => toggle(e)} /> {e.name ?? e.slug}
        </label>
      ))}
      {odd.map((v) => (
        <label key={v} className="form-check">
          <input type="checkbox" checked onChange={() => onChange(value.filter((x) => x !== v))} /> {v} <span className="muted">(not in the Codex)</span>
        </label>
      ))}
    </fieldset>
  );
}

const isNumber = (text) => text.trim() !== '' && Number.isFinite(Number(text));

/**
 * New event: title, slug (made from the title until you type one), when (the story's own calendar), order (after the selected event, or last + 10), date (optional ISO).
 * @param {{ sorted: any[], selectedId?: string | null, takenSlugs?: Set<string>, onSubmit: (v: { title: string, slug: string, when: string, order: number, date: string }) => Promise<any>, onClose: () => void }} props
 */
export function NewEventDialog({ sorted, selectedId = null, takenSlugs = new Set(), onSubmit, onClose }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [when, setWhen] = useState('');
  const [order, setOrder] = useState(String(defaultOrder(sorted, selectedId)));
  const [date, setDate] = useState('');
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const shown = touched ? slug : title.trim() === '' ? '' : slugify(title);
  return (
    <Dialog label="New event" onClose={onClose}>
      <h2>New event</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === '') return setProblem('Give the event a title.');
          if (!SLUG_RE.test(shown) || shown.length > 60) return setProblem('The slug must be lower-case letters, digits and single hyphens (up to 60 characters).');
          if (takenSlugs.has(shown)) return setProblem('That slug is already used by another entry, thread or event. Choose a different one.');
          if (!isNumber(order)) return setProblem('The order must be a number, for example 150 or 125.5.');
          if (date.trim() !== '' && !DATE_RE.test(date.trim())) return setProblem('The date must be YYYY, YYYY-MM or YYYY-MM-DD, or empty.');
          setProblem(null);
          return run({ title: title.trim(), slug: shown, when: when.trim(), order: Number(order), date: date.trim() });
        }}
      >
        <Row label="Title">
          <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Row>
        <Row label="Slug" hint={`The file is planning/timeline/${shown || '<slug>'}.md`}>
          <input
            type="text"
            name="slug"
            value={shown}
            autoComplete="off"
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Row>
        <Row label="When" hint='In your story&apos;s own calendar, for example "Spring, year 30". A label only.'>
          <input type="text" name="when" value={when} autoComplete="off" onChange={(e) => setWhen(e.target.value)} />
        </Row>
        <Row label="Order" hint="Where it falls in story time. Smaller is earlier; decimals are fine. Other events are never renumbered.">
          <input type="text" inputMode="decimal" name="order" value={order} autoComplete="off" onChange={(e) => setOrder(e.target.value)} />
        </Row>
        <Row label="Date" hint="Optional, if your story uses a real calendar: 1998, 1998-07 or 1998-07-21.">
          <input type="text" name="date" value={date} autoComplete="off" onChange={(e) => setDate(e.target.value)} />
        </Row>
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Edit fields: title, when, order, date, characters and locations. Only what changed is handed on (a list is replaced as a whole).
 * @param {{ event: any, entries: { id: string, slug: string | null, name: string | null, type: string | null }[], onSubmit: (patch: Record<string, any>) => Promise<any>, onClose: () => void }} props
 */
export function EditEventDialog({ event, entries, onSubmit, onClose }) {
  const [title, setTitle] = useState(event.title ?? '');
  const [when, setWhen] = useState(event.when ?? '');
  const [order, setOrder] = useState(event.order === null ? '' : String(event.order));
  const [date, setDate] = useState(event.date ?? '');
  const [characters, setCharacters] = useState(event.characters);
  const [locations, setLocations] = useState(event.locations);
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const people = entries.filter((e) => e.type === 'character');
  const places = entries.filter((e) => e.type === 'location');
  return (
    <Dialog label="Edit event" onClose={onClose}>
      <h2>Edit {event.title ?? event.slug}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === '') return setProblem('The event needs a title.');
          if (!isNumber(order)) return setProblem('The order must be a number, for example 150 or 125.5.');
          if (date.trim() !== '' && !DATE_RE.test(date.trim())) return setProblem('The date must be YYYY, YYYY-MM or YYYY-MM-DD, or empty.');
          const patch = {};
          if (title.trim() !== (event.title ?? '')) patch.title = title.trim();
          if (when.trim() !== (event.when ?? '')) patch.when = when.trim();
          if (Number(order) !== event.order) patch.order = Number(order);
          if (date.trim() !== (event.date ?? '')) patch.date = date.trim();
          if (JSON.stringify(characters) !== JSON.stringify(event.characters)) patch.characters = characters;
          if (JSON.stringify(locations) !== JSON.stringify(event.locations)) patch.locations = locations;
          if (Object.keys(patch).length === 0) return setProblem('Nothing was changed.');
          setProblem(null);
          return run(patch);
        }}
      >
        <Row label="Title">
          <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Row>
        <Row label="When">
          <input type="text" name="when" value={when} autoComplete="off" onChange={(e) => setWhen(e.target.value)} />
        </Row>
        <Row label="Order" hint="Smaller is earlier in story time; decimals are fine.">
          <input type="text" inputMode="decimal" name="order" value={order} autoComplete="off" onChange={(e) => setOrder(e.target.value)} />
        </Row>
        <Row label="Date" hint="Optional: 1998, 1998-07 or 1998-07-21.">
          <input type="text" name="date" value={date} autoComplete="off" onChange={(e) => setDate(e.target.value)} />
        </Row>
        <RefPicker legend="Characters" entries={people} value={characters} onChange={setCharacters} />
        <RefPicker legend="Locations" entries={places} value={locations} onChange={setLocations} />
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Add or remove the event's scenes. The optional checkbox keeps the scenes' own `events` lists in step (a two-sided link); a link that only one side makes is still valid.
 * @param {{ event: any, scenes: { id: string, title: string | null, chapter_label: string | null }[], onSubmit: (v: { add: string[], remove: string[], twoSided: boolean }) => Promise<any>, onClose: () => void }} props
 */
export function EventScenesDialog({ event, scenes, onSubmit, onClose }) {
  const current = new Set(event.scenes.map((s) => s.id));
  const [picked, setPicked] = useState(() => new Set(current));
  const [twoSided, setTwoSided] = useState(true);
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const live = new Set(scenes.map((s) => s.id));
  const gone = event.scenes.filter((s) => !live.has(s.id));
  const flip = (id) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog label="Scenes of the event" onClose={onClose}>
      <h2>Scenes of {event.title ?? event.slug}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const add = [...picked].filter((id) => !current.has(id));
          const remove = [...current].filter((id) => !picked.has(id));
          if (add.length === 0 && remove.length === 0) return setProblem('Nothing was changed.');
          setProblem(null);
          return run({ add, remove, twoSided });
        }}
      >
        <fieldset className="tl-picker">
          <legend>Scenes that tell this event</legend>
          {scenes.map((s) => (
            <label key={s.id} className="form-check">
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => flip(s.id)} /> {s.title || 'Untitled scene'}
              {s.chapter_label && <span className="muted"> · {s.chapter_label}</span>}
            </label>
          ))}
          {gone.map((s) => (
            <label key={s.id} className="form-check">
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => flip(s.id)} /> {s.title ?? s.id} <span className="muted">({s.state})</span>
            </label>
          ))}
        </fieldset>
        <label className="form-check">
          <input type="checkbox" checked={twoSided} onChange={(e) => setTwoSided(e.target.checked)} /> Also keep each scene&apos;s own list of events in step (both sides of the link)
        </label>
        <p className="muted form-hint">Off: only the event&apos;s file changes. A link made by one side alone is still valid.</p>
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Preview
          </button>
        </div>
      </form>
    </Dialog>
  );
}
