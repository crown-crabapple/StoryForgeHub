import { useEffect, useMemo, useRef, useState } from 'react';
import { ProseView } from '../ProseView.jsx';
import { Link } from '../router.jsx';
import { viewHref } from '../planning/model.js';
import { placeholderHeight, positionKey, readingOrder, readingProgress, readingTime, withoutComments } from './model.js';

const PARALLEL = 6;
const PREFS_KEY = 'storyforge.read.prefs';
const DEFAULT_PREFS = { titles: true, notes: false };

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window or storage off: the view works without it
  }
}
function storedPosition(bookId) {
  try {
    return localStorage.getItem(positionKey(bookId));
  } catch {
    return null;
  }
}

/** A jump: the scenes still waiting from the picked one onwards come first (so the chapter you picked shows at once), then the ones before it. @param {string[]} q @param {string | null} id */
function frontFirst(q, id) {
  const at = id ? q.indexOf(id) : -1;
  if (at > 0) q.splice(0, q.length, ...q.slice(at), ...q.slice(0, at));
}

/**
 * Every scene of the book, fetched in reading order a few at a time, starting at `priority` (the scene being jumped to) when there is one.
 * A refresh (`version`) fetches again but keeps showing what it has.
 * @returns {Map<string, any>} scene id -> GET /api/books/:b/scenes/:s, or { failed: true }
 */
function useSceneBodies(bookId, ids, version, priority = null) {
  const [scenes, setScenes] = useState(() => new Map());
  const idsKey = ids.join(',');
  const queueRef = useRef(/** @type {string[]} */ ([]));
  const priorityRef = useRef(priority);
  useEffect(() => {
    priorityRef.current = priority;
    frontFirst(queueRef.current, priority);
  }, [priority]);
  useEffect(() => {
    const ctrl = new AbortController();
    const queue = idsKey ? idsKey.split(',') : [];
    frontFirst(queue, priorityRef.current);
    queueRef.current = queue;
    const worker = async () => {
      while (queue.length > 0 && !ctrl.signal.aborted) {
        const id = queue.shift();
        let value;
        try {
          const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(id)}`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
          value = res.ok ? await res.json() : { failed: true };
        } catch (e) {
          if (e?.name === 'AbortError') return;
          value = { failed: true };
        }
        if (!ctrl.signal.aborted) setScenes((prev) => new Map(prev).set(id, value));
      }
    };
    for (let i = 0; i < Math.min(PARALLEL, queue.length); i++) worker();
    return () => ctrl.abort();
  }, [bookId, idsKey, version]);
  return scenes;
}

/** One scene in the flow: its text, or a placeholder of about its height until it arrives. */
function ReadScene({ bookId, entry, scene, showTitle, showNotes, headingLevel }) {
  const H = `h${headingLevel}`;
  let body;
  if (!scene) {
    body = <div className="read-placeholder" style={{ minHeight: placeholderHeight(entry.word_count ?? 0) }} aria-hidden="true" />;
  } else if (scene.failed) {
    body = <p className="error">This scene could not be loaded.</p>;
  } else if (scene.problem) {
    body = (
      <>
        <p className="error">
          This file can't be read ({scene.problem.code}: {scene.problem.message}). Its text is shown exactly as it is on disk.
        </p>
        <pre className="scene-text">{scene.body}</pre>
      </>
    );
  } else {
    const text = scene.body ?? '';
    body = <ProseView source={showNotes ? text : withoutComments(text)} />;
  }
  return (
    <section className="read-scene" id={`read-${entry.id}`} data-read-scene={entry.id} aria-label={entry.title || 'Untitled scene'} aria-busy={scene ? undefined : 'true'}>
      <Link to={viewHref(bookId, 'write', { scene: entry.id })} className="read-edit btn btn-small" aria-label={`Edit "${entry.title || 'Untitled scene'}"`}>
        Edit
      </Link>
      {showTitle && <H className="read-scene-title">{entry.title || 'Untitled scene'}</H>}
      {body}
    </section>
  );
}

/**
 * The Read view of the Manuscript tab: the whole manuscript as one continuous page, for reading and reviewing. Read only; each scene has
 * an Edit link to the Write view. Remembers where you were in each book; `jumpTo` ({ id }) scrolls to a scene (the rail's scene links).
 * @param {{ book: any, version?: string, initialScene?: string | null, jumpTo?: { id: string } | null, onCurrent?: (sceneId: string | null) => void, viewSwitch?: import('react').ReactNode }} props
 */
export function ReadView({ book, version = '', initialScene = null, jumpTo = null, onCurrent, viewSwitch = null }) {
  const order = useMemo(() => readingOrder(book), [book]);
  const ids = useMemo(() => order.scenes.map((s) => s.id), [order]);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [current, setCurrent] = useState(null);
  const known = (id) => Boolean(id) && ids.includes(id);
  // the scene to scroll to once it has loaded: the one in the address, else where you stopped reading last time
  const [target, setTarget] = useState(() => {
    const stored = storedPosition(book.id);
    return known(initialScene) ? initialScene : known(stored) ? stored : null;
  });
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const scenes = useSceneBodies(book.id, ids, version, target);
  // a jump from the rail (a new { id } object each time)
  const [seenJump, setSeenJump] = useState(jumpTo);
  if (jumpTo !== seenJump) {
    setSeenJump(jumpTo);
    if (jumpTo && known(jumpTo.id)) setTarget(jumpTo.id);
  }

  const setPref = (k, v) =>
    setPrefs((p) => {
      const next = { ...p, [k]: v };
      store(PREFS_KEY, JSON.stringify(next));
      return next;
    });

  // a jump goes at once (scenes not loaded yet stand in at about their height), and stays on its scene while the scenes above it arrive and
  // change height; it lets go once everything above it is in place, or as soon as you scroll yourself
  useEffect(() => {
    if (!target) return undefined;
    const i = ids.indexOf(target);
    if (i !== -1) document.getElementById(`read-${target}`)?.scrollIntoView({ block: 'start' });
    const settled = i === -1 || ids.slice(0, i + 1).every((id) => scenes.has(id));
    const frame = requestAnimationFrame(() => {
      if (i !== -1) setCurrent(target);
      if (settled) setTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ids, scenes]);
  useEffect(() => {
    const letGo = () => {
      if (targetRef.current) setTarget(null);
    };
    window.addEventListener('wheel', letGo, { passive: true });
    window.addEventListener('touchmove', letGo, { passive: true });
    return () => {
      window.removeEventListener('wheel', letGo);
      window.removeEventListener('touchmove', letGo);
    };
  }, []);

  // which scene is being read: the last one whose top has passed a line a quarter of the way down the window
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (targetRef.current) return;
      const els = document.querySelectorAll('[data-read-scene]');
      const line = window.innerHeight * 0.25;
      let lo = 0;
      let hi = els.length - 1;
      let found = els.length ? 0 : -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (els[mid].getBoundingClientRect().top <= line) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const id = found === -1 ? null : els[found].getAttribute('data-read-scene');
      setCurrent((prev) => (prev === id ? prev : id));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [order]);

  useEffect(() => {
    if (!current) return;
    store(positionKey(book.id), current);
    onCurrent?.(current);
  }, [book.id, current, onCurrent]);

  const goTo = (id) => setTarget(id);

  if (order.scenes.length === 0) {
    return (
      <>
        {viewSwitch}
        <h1>{book.title ?? book.slug ?? book.id}</h1>
        <p className="muted">This book has no scenes in its manuscript.</p>
      </>
    );
  }

  const progress = readingProgress(order, current ?? ids[0]);
  // while a jump is on its way the picker already shows the chapter you picked
  const currentChapter = order.scenes.find((s) => s.id === (target ?? current ?? ids[0]))?.chapterKey ?? '';
  const loaded = ids.filter((id) => scenes.has(id)).length;
  const hasActs = order.acts.some((a) => a.name);
  const chapterLevel = hasActs ? 3 : 2;

  return (
    <>
      {viewSwitch}
      <div className="read-bar" role="toolbar" aria-label="Reading">
        <label className="read-jump">
          <span className="sr-only">Go to chapter</span>
          <select
            value={currentChapter}
            onChange={(e) => {
              const first = order.scenes.find((s) => s.chapterKey === e.target.value);
              if (first) goTo(first.id);
            }}
          >
            {order.acts.map((a) =>
              a.name ? (
                <optgroup key={a.key} label={a.name}>
                  {a.chapters.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ) : (
                a.chapters.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))
              ),
            )}
          </select>
        </label>
        <label className="read-toggle">
          <input type="checkbox" checked={prefs.titles} onChange={(e) => setPref('titles', e.target.checked)} /> Scene titles
        </label>
        <label className="read-toggle">
          <input type="checkbox" checked={prefs.notes} onChange={(e) => setPref('notes', e.target.checked)} /> Notes
        </label>
        <span className="read-progress muted" aria-live="off">
          {progress ? `Scene ${progress.index} of ${progress.total} · ${progress.percent}% · ${progress.left} left` : ''}
          {loaded < ids.length ? ` · loading ${loaded}/${ids.length}` : ''}
        </span>
      </div>
      <article className="paper read-paper">
        <header className="read-head">
          <h1>{book.title ?? book.slug ?? book.id}</h1>
          <p className="paper-meta">
            {order.words.toLocaleString('en-US')} words · {order.scenes.length} scenes · about {readingTime(order.words)} to read
          </p>
        </header>
        {order.acts.map((act) => (
          <div key={act.key} className="read-act">
            {act.name && <h2 className="read-act-title">{act.name}</h2>}
            {act.chapters.map((ch) => {
              const CH = `h${chapterLevel}`;
              return (
                <section key={ch.key} className="read-chapter" aria-label={ch.name}>
                  <CH className="read-chapter-title">{ch.name}</CH>
                  {ch.scenes.map((s, i) => (
                    <div key={s.id}>
                      {i > 0 && <hr className="read-break" />}
                      <ReadScene bookId={book.id} entry={s} scene={scenes.get(s.id)} showTitle={prefs.titles} showNotes={prefs.notes} headingLevel={chapterLevel + 1} />
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        ))}
        <footer className="paper-footer read-end">
          <span className="muted">End of the manuscript · {order.words.toLocaleString('en-US')} words</span>
          <button type="button" className="btn btn-small" onClick={() => window.scrollTo({ top: 0 })}>
            Back to top
          </button>
        </footer>
      </article>
    </>
  );
}
