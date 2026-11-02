import { useId, useState } from 'react';
import { useApi } from '../api.js';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { LINK_GROUPS, sceneLinkItems } from './scene-context.js';

const show = (v) => (Array.isArray(v) ? v.join(', ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A short card for one entry: name, type and status, the opening of its first section and its fields. */
export function EntryPreview({ bookId, entryRef, id }) {
  const { data, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}/entries/${encodeURIComponent(entryRef)}`);
  const fields = Object.entries(data?.fields ?? {});
  const first = data?.sections?.[0];
  return (
    <div id={id} className="entry-preview" role="region" aria-label="Entry preview">
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !data && <p className="muted">There is no Codex entry to preview for this.</p>}
      {data && (
        <>
          <p className="entry-preview-name">
            <strong>{data.name}</strong>
          </p>
          <p className="muted">{[data.type, data.status].filter(Boolean).join(' · ')}</p>
          {first && <p className="entry-preview-text">{first.text}</p>}
          {fields.length > 0 && (
            <dl className="entry-preview-fields">
              {fields.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{show(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

function LinkItem({ bookId, item }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="link-item">
      <button type="button" className="link-chip" title={item.ref} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>{item.name}</span>
      </button>
      {item.mentioned && <span className="tag">mentioned</span>}
      {open && <EntryPreview bookId={bookId} entryRef={item.ref} id={id} />}
    </li>
  );
}

/**
 * "In this scene": the characters, locations and threads of the front matter and every [[link]] of the body, each once; a link that
 * only the body makes is tagged "mentioned". Each is a button that opens an entry preview.
 * @param {{ bookId: string, front: Record<string, any> | null | undefined, body: string, objects?: any[] | null }} props
 */
export function LinkedEntries({ bookId, front, body, objects = null }) {
  const items = sceneLinkItems(front, body, objects);
  return (
    <InspectorSection title="In this scene">
      {items.length === 0 ? (
        <p className="muted">Nothing is linked to this scene yet.</p>
      ) : (
        LINK_GROUPS.map((g) => {
          const list = items.filter((i) => i.group === g.id);
          if (list.length === 0) return null;
          return (
            <div className="refs" key={g.id}>
              <span className="refs-label">{g.title}</span>
              <ul>
                {list.map((item) => (
                  <LinkItem key={item.key} bookId={bookId} item={item} />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </InspectorSection>
  );
}
