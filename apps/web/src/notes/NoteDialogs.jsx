// The forms of the Notes page. Each one only collects input and hands it to `onSubmit(values)`, which resolves to { error } (the form stays open and shows it) or
// { close: true }; the page builds the request, shows the dry-run diff and writes only when the author presses Apply.
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { slugify } from '../structure/helpers.js';
import { KIND_LABEL, tagsOf } from './model.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SOURCE_FIELDS = [
  ['author', 'Author'],
  ['year', 'Year'],
  ['type', 'Type (book, article, report ...)'],
  ['publisher', 'Publisher'],
  ['url', 'URL (never fetched)'],
  ['accessed', 'Accessed'],
  ['locator', 'Locator (page, chapter ...)'],
];

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
  return { busy, error, run };
}

function Actions({ busy, onClose, submit = 'Preview' }) {
  return (
    <div className="dialog-actions">
      <button type="button" className="btn" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {submit}
      </button>
    </div>
  );
}

/**
 * New research note, planning doc or source (`kind`). The file name is made from the title (a source's from its cite key) until you type one.
 * @param {{ kind: 'research' | 'doc' | 'source', takenCites?: Set<string>, onSubmit: (v: any) => Promise<any>, onClose: () => void }} props
 */
export function NewNoteDialog({ kind, takenCites = new Set(), onSubmit, onClose }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [cite, setCite] = useState('');
  const [citeTouched, setCiteTouched] = useState(false);
  const [tags, setTags] = useState('');
  const [source, setSource] = useState({});
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const isSource = kind === 'source';
  const shown = touched ? slug : title.trim() === '' ? '' : slugify(title);
  const shownCite = citeTouched ? cite : title.trim() === '' ? '' : slugify(title);
  const folder = kind === 'research' ? 'research' : kind === 'doc' ? 'planning' : 'research/sources';
  const heading = `New ${kind === 'research' ? 'research note' : kind === 'doc' ? 'planning doc' : 'source'}`;
  return (
    <Dialog label={heading} onClose={onClose}>
      <h2>{heading}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === '') return setProblem('Give it a title.');
          if (isSource) {
            if (!SLUG_RE.test(shownCite) || shownCite.length > 60) return setProblem('The cite key must be lower-case letters, digits and single hyphens (up to 60 characters).');
            if (takenCites.has(shownCite)) return setProblem('Another source already uses that cite key. Choose a different one.');
          } else if (!SLUG_RE.test(shown) || shown.length > 60) return setProblem('The file name must be lower-case letters, digits and single hyphens (up to 60 characters).');
          setProblem(null);
          return run({ kind, title: title.trim(), ...(isSource ? { cite_key: shownCite, ...source } : { slug: shown }), ...(kind === 'research' ? { tags: tagsOf(tags) } : {}) });
        }}
      >
        <Row label="Title">
          <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Row>
        {isSource ? (
          <>
            <Row label="Cite key" hint={`Cite it in your text as [@${shownCite || 'cite-key'}]. The file is research/sources/${shownCite || '<cite-key>'}.md`}>
              <input
                type="text"
                name="cite_key"
                value={shownCite}
                autoComplete="off"
                onChange={(e) => {
                  setCiteTouched(true);
                  setCite(e.target.value);
                }}
              />
            </Row>
            {SOURCE_FIELDS.map(([key, label]) => (
              <Row key={key} label={label}>
                <input type="text" name={key} value={source[key] ?? ''} autoComplete="off" onChange={(e) => setSource((s) => ({ ...s, [key]: e.target.value }))} />
              </Row>
            ))}
          </>
        ) : (
          <Row label="File name" hint={`The file is ${folder}/${shown || '<name>'}.md`}>
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
        )}
        {kind === 'research' && (
          <Row label="Tags" hint="Separate tags with commas.">
            <input type="text" name="tags" value={tags} autoComplete="off" onChange={(e) => setTags(e.target.value)} />
          </Row>
        )}
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <Actions busy={busy} onClose={onClose} />
      </form>
    </Dialog>
  );
}

/**
 * Edit a note's fields. Research: title, tags, canon, links (entries, threads, events) and sources; doc: title and locked; source: title and its fields. Only what
 * changed is handed on.
 * @param {{ note: any, objects: { id: string, kind: string, slug: string | null, name: string | null }[], sources: any[], onSubmit: (patch: Record<string, any>) => Promise<any>, onClose: () => void }} props
 */
export function EditNoteDialog({ note, objects, sources, onSubmit, onClose }) {
  const [title, setTitle] = useState(note.title ?? '');
  const [tags, setTags] = useState(note.tags.join(', '));
  const [canon, setCanon] = useState(note.canon);
  const [locked, setLocked] = useState(note.locked);
  const [links, setLinks] = useState(note.links.map((l) => l.ref));
  const [cites, setCites] = useState(note.sources.map((s) => s.cite_key));
  const [fields, setFields] = useState({ ...(note.source ?? {}) });
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useSubmit(onSubmit, onClose);
  const hasLink = (o) => links.includes(o.slug) || links.includes(o.id);
  const known = new Set(objects.flatMap((o) => [o.slug, o.id]));
  const toggleLink = (o) => setLinks((l) => (hasLink(o) ? l.filter((x) => x !== o.slug && x !== o.id) : [...l, o.slug ?? o.id]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return (
    <Dialog label={`Edit ${KIND_LABEL[note.kind]?.toLowerCase() ?? 'note'}`} onClose={onClose}>
      <h2>Edit {note.title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === '') return setProblem('The note needs a title.');
          const patch = {};
          if (title.trim() !== (note.title ?? '')) patch.title = title.trim();
          if (note.kind === 'research') {
            if (!same(tagsOf(tags), note.tags)) patch.tags = tagsOf(tags);
            if (canon !== note.canon) patch.canon = canon;
            if (!same(links, note.links.map((l) => l.ref))) patch.links = links;
            if (!same(cites, note.sources.map((s) => s.cite_key))) patch.sources = cites;
          } else if (note.kind === 'doc') {
            if (locked !== note.locked) patch.locked = locked;
          } else {
            for (const [key] of SOURCE_FIELDS) if ((fields[key] ?? '') !== (note.source?.[key] ?? '')) patch[key] = fields[key] ?? '';
          }
          if (Object.keys(patch).length === 0) return setProblem('Nothing was changed.');
          setProblem(null);
          return run(patch);
        }}
      >
        <Row label="Title">
          <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Row>
        {note.kind === 'research' && (
          <>
            <Row label="Tags" hint="Separate tags with commas.">
              <input type="text" name="tags" value={tags} autoComplete="off" onChange={(e) => setTags(e.target.value)} />
            </Row>
            <label className="form-check">
              <input type="checkbox" name="canon" checked={canon} onChange={(e) => setCanon(e.target.checked)} /> Canon
            </label>
            <p className="muted form-hint">Research is background. Continuity checks only treat it as fact when you mark it canon.</p>
            <fieldset className="tl-picker">
              <legend>Links</legend>
              {objects.map((o) => (
                <label key={o.id} className="form-check">
                  <input type="checkbox" checked={hasLink(o)} onChange={() => toggleLink(o)} /> {o.name ?? o.slug} <span className="muted">({o.kind})</span>
                </label>
              ))}
              {links.filter((l) => !known.has(l)).map((l) => (
                <label key={l} className="form-check">
                  <input type="checkbox" checked onChange={() => setLinks((x) => x.filter((v) => v !== l))} /> {l} <span className="muted">(not in the book)</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="tl-picker">
              <legend>Sources</legend>
              {sources.length === 0 && <p className="muted">No sources yet. Add one with New source.</p>}
              {sources.map((s) => (
                <label key={s.id} className="form-check">
                  <input type="checkbox" checked={cites.includes(s.cite_key)} onChange={() => setCites((c) => (c.includes(s.cite_key) ? c.filter((x) => x !== s.cite_key) : [...c, s.cite_key]))} /> {s.title}{' '}
                  <span className="muted">[@{s.cite_key}]</span>
                </label>
              ))}
              {cites.filter((c) => !sources.some((s) => s.cite_key === c)).map((c) => (
                <label key={c} className="form-check">
                  <input type="checkbox" checked onChange={() => setCites((x) => x.filter((v) => v !== c))} /> [@{c}] <span className="muted">(not found)</span>
                </label>
              ))}
            </fieldset>
          </>
        )}
        {note.kind === 'doc' && (
          <label className="form-check">
            <input type="checkbox" name="locked" checked={locked} onChange={(e) => setLocked(e.target.checked)} /> Locked (StoryForge asks before editing it)
          </label>
        )}
        {note.kind === 'source' &&
          SOURCE_FIELDS.map(([key, label]) => (
            <Row key={key} label={label}>
              <input type="text" name={key} value={fields[key] ?? ''} autoComplete="off" onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))} />
            </Row>
          ))}
        {(problem || error) && (
          <p role="alert" className="error">
            {problem ?? error}
          </p>
        )}
        <Actions busy={busy} onClose={onClose} />
      </form>
    </Dialog>
  );
}
