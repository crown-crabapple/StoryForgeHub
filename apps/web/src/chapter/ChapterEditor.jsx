// The Write view: every scene of the current chapter in one continuous rich-text editor (TipTap 3), with fixed scene breaks and one save controller per scene.
// The author never sees Markdown. Scenes stay Markdown on the server: each is converted on load (packages/format/src/rich.mjs) and back on save, and a scene whose
// Markdown did not change is never saved. See docs/plans/phase2/design.md.
import { TextSelection } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { abilities } from '../collab/model.js';
import { PresenceNote, usePresence } from '../collab/Presence.jsx';
import { createDraftStore, draftKey } from '../editor/draft-store.js';
import { useEditorBridge } from '../editor/bridge.jsx';
import { decideRestore, getOfflineQueue } from '../editor/offline-queue.js';
import { createSaveController, draftOffer } from '../editor/save-controller.js';
import { flushOnLeave } from '../receipts/model.js';
import { Link } from '../router.jsx';
import { useShortcuts } from '../shortcuts/ShortcutsContext.jsx';
import { useSession } from '../shared/session.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookUrl, explainFailure, send, slugify } from '../structure/helpers.js';
import { useStructure } from '../structure/useStructure.jsx';
import { SuggestionDialog } from '../suggestions/RailSuggestions.jsx';
import { useSuggestionActions } from '../suggestions/useSuggestionActions.jsx';
import { useWriting } from '../writing/WritingContext.jsx';
import { authorNotesByScene, buildChapterDoc, changedScenes, editedSceneIds, replaceSceneTransaction, sceneAt, sceneSlices, splitChapterDoc } from './chapter-doc.js';
import { aggregateSaveState, cannotSaveText, readNotesOpen, writeNotesOpen } from './chapter-state.js';
import { ChapterContext } from './ChapterContext.js';
import { ChapterToolbar } from './ChapterToolbar.jsx';
import { validateChapterDoc } from './schema.js';
import { chapterEditorExtensions } from './SceneBreakView.jsx';

const PARALLEL = 6;
const SERIALIZE_MS = 250;

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const without = (map, key) => {
  const out = { ...map };
  delete out[key];
  return out;
};

const sourceHref = (bookId, sceneId) => `/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(sceneId)}&view=source`;

/** Every scene of the chapter, fetched a few at a time. @returns {{ loaded: Map<string, any> | null, done: number }} `loaded` once all are in; a scene that failed is `{ failed: true }` */
function useChapterScenes(bookId, ids) {
  const [state, setState] = useState({ key: '', loaded: /** @type {Map<string, any> | null} */ (null), done: 0 });
  const idsKey = ids.join(',');
  const stateKey = `${bookId}|${idsKey}`;
  useEffect(() => {
    const ctrl = new AbortController();
    const queue = idsKey ? idsKey.split(',') : [];
    const results = new Map();
    const finish = () => {
      if (ctrl.signal.aborted) return;
      if (results.size === (idsKey ? idsKey.split(',').length : 0)) setState({ key: stateKey, loaded: results, done: results.size });
      else setState({ key: stateKey, loaded: null, done: results.size });
    };
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
        results.set(id, value);
        finish();
      }
    };
    if (queue.length === 0) finish();
    for (let i = 0; i < Math.min(PARALLEL, queue.length); i++) void worker();
    return () => ctrl.abort();
  }, [bookId, idsKey, stateKey]);
  // a chapter that changed (scenes added, moved, reordered) is read again: until then there is nothing to show
  return state.key === stateKey ? state : { loaded: null, done: 0 };
}

/**
 * The chapter editor. Render it inside the book layout. It reloads (a fresh editor) whenever the chapter's scenes change: a scene added, moved in or out, reordered.
 * @param {{ book: any, chapter: any, act: number, activeId: string | null, chapterLabel?: string | null, onStructureChanged?: (info?: any) => void, onCursorScene?: (sceneId: string) => void }} props
 *   `chapter`: the chapter node of the book tree (its scenes, in order); `activeId`: the scene the address names (the editor scrolls to it); `onCursorScene`: the scene the cursor entered.
 */
export function ChapterEditor({ book, chapter, act, activeId, chapterLabel = null, onStructureChanged, onCursorScene }) {
  const ids = chapter.scenes.map((s) => s.id);
  const bookIds = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
  const bookKey = bookIds.join(',');
  // a scene that was not in the book before and is the open one was just made: it gets the cursor (derived during render, no effect)
  const [seen, setSeen] = useState(() => ({ key: bookKey, ids: new Set(bookIds), fresh: /** @type {string | null} */ (null) }));
  if (seen.key !== bookKey) setSeen({ key: bookKey, ids: new Set(bookIds), fresh: bookIds.find((id) => id === activeId && !seen.ids.has(id)) ?? null });
  const { loaded, done } = useChapterScenes(book.id, ids);
  if (!loaded) {
    return (
      <p className="muted" role="status">
        Loading the chapter… {done} of {ids.length}
      </p>
    );
  }
  return (
    <ChapterSurface
      key={`${book.id}|${chapter.chapter}|${ids.join(',')}`}
      book={book}
      chapter={chapter}
      act={act}
      loaded={loaded}
      activeId={activeId}
      focusSceneId={seen.fresh}
      chapterLabel={chapterLabel}
      onStructureChanged={onStructureChanged}
      onCursorScene={onCursorScene}
    />
  );
}

/** Put the cursor at the start of a scene's text, and the scene in view. @param {import('@tiptap/core').Editor} editor @param {string} sceneId @param {{ focus?: boolean }} [opts] */
function showScene(editor, sceneId, { focus = false } = {}) {
  if (editor.isDestroyed) return;
  const slice = sceneSlices(editor.state.doc).find((s) => s.sceneId === sceneId);
  if (!slice) return;
  if (focus) {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(slice.from), 1)));
    editor.view.focus();
  }
  const dom = editor.view.nodeDOM(slice.breakPos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start' });
}

function ChapterSurface({ book, chapter, act, loaded, activeId, focusSceneId, chapterLabel, onStructureChanged, onCursorScene }) {
  const summaries = chapter.scenes;
  const bridge = useEditorBridge();
  const session = useSession();
  const can = abilities(session);
  const sharedMode = session.mode === 'shared';
  const writing = useWriting();
  const shortcuts = useShortcuts();
  const { setEditor, track } = useWrites();
  const suggestionActions = useSuggestionActions({ bookId: book.id, onChanged: onStructureChanged });

  const [snaps, setSnaps] = useState({});
  const [errors, setErrors] = useState({});
  const [notices, setNotices] = useState({});
  const [offers, setOffers] = useState({});
  const [queued, setQueued] = useState({});
  const [notes, setNotes] = useState({});
  const [notesOpen, setNotesOpen] = useState(() => readNotesOpen(storage()));
  const [summaryOf, setSummaryOf] = useState(() => Object.fromEntries(summaries.map((s) => [s.id, typeof loaded.get(s.id)?.front_matter?.summary === 'string' ? loaded.get(s.id).front_matter.summary : ''])));
  const [titleOverride, setTitleOverride] = useState(/** @type {Record<string, { value: string, base: string }>} */ ({}));
  const [cursorScene, setCursorScene] = useState(activeId ?? summaries[0]?.id ?? null);
  const [reviewId, setReviewId] = useState(/** @type {string | null} */ (null));

  // the latest of what the long-lived handlers below need (they are created once per editor)
  const latest = useRef({ book, summaries, loaded, track, onStructureChanged, onCursorScene, writing, shortcuts, can, activeId });
  useEffect(() => {
    latest.current = { book, summaries, loaded, track, onStructureChanged, onCursorScene, writing, shortcuts, can, activeId };
  });
  const cursorRef = useRef(cursorScene);
  const offersRef = useRef(offers);
  const notesOpenRef = useRef(notesOpen);
  useEffect(() => {
    offersRef.current = offers;
    notesOpenRef.current = notesOpen;
  });
  /** What the editor effect makes available to the actions: the controllers, the draft store and the helpers that need the editor. */
  const apiRef = useRef(/** @type {{ ctls: Map<string, ReturnType<typeof createSaveController>>, drafts: ReturnType<typeof createDraftStore> | null, applyScene: (id: string, text: string) => void, flushAll: () => Promise<{ saved: boolean }>, goTo: (pos: number) => void }} */ ({ ctls: new Map(), drafts: null, applyScene: () => {}, flushAll: async () => ({ saved: true }), goTo: () => {} }));

  const [initialDoc] = useState(() =>
    buildChapterDoc(
      summaries.map((s) => {
        const json = loaded.get(s.id);
        return json && !json.failed ? { ...json, id: s.id, title: json.title ?? s.title } : { id: s.id, title: s.title, failed: true };
      }),
    ),
  );
  const [docProblem] = useState(() => validateChapterDoc(initialDoc));

  const editor = useEditor(
    {
      extensions: chapterEditorExtensions,
      content: docProblem ? '' : initialDoc,
      editable: !can.readOnly,
      editorProps: { attributes: { class: 'sf-prose', 'aria-label': 'Chapter text', spellcheck: 'true' } },
    },
    [],
  );
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!can.readOnly);
  }, [editor, can.readOnly]);

  const setNotice = useCallback((id, message) => setNotices((p) => ({ ...p, [id]: message })), []);

  // ---- the editor, the save controllers and the draft store live and die with this chapter
  useEffect(() => {
    if (!editor || docProblem) return undefined;
    const bookId = latest.current.book.id;
    const drafts = createDraftStore();
    // shared mode: unsent text is also kept in the offline queue (as the scene editor does); personal mode keeps the draft store alone
    const queue = sharedMode ? getOfflineQueue() : null;
    /** @type {Map<string, ReturnType<typeof createSaveController>>} */
    const ctls = new Map();
    const failed = new Set();
    const touched = new Set();
    let timer = null;
    let cancelled = false;
    let previous = sceneSlices(editor.state.doc);
    let lastNotes = '';

    for (const slice of previous) {
      if (slice.sceneId === null || slice.node.attrs.readOnly) continue;
      const id = slice.sceneId;
      const json = latest.current.loaded.get(id);
      ctls.set(
        id,
        createSaveController({
          bookId,
          sceneId: id,
          text: json.body,
          sha256: json.sha256 ?? null,
          shared: sharedMode,
          offlineQueue: queue,
          drafts,
          onChange: (snap) => setSnaps((p) => ({ ...p, [id]: snap })),
          onSaved: (words) => latest.current.writing.applySaved(words),
        }),
      );
    }

    const updateNotes = (doc) => {
      const next = Object.fromEntries(authorNotesByScene(doc));
      const key = JSON.stringify(next);
      if (key !== lastNotes) {
        lastNotes = key;
        setNotes(next);
      }
    };
    updateNotes(editor.state.doc);

    /** Turn the scenes edited since last time into Markdown and hand the changed ones to their controllers. A scene that cannot be written is never saved. */
    const serialize = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (editor.isDestroyed) return;
      const doc = editor.state.doc;
      const next = sceneSlices(doc);
      const ids = editedSceneIds(previous, next).filter((id) => ctls.has(id));
      previous = next;
      updateNotes(doc);
      if (ids.length === 0) return;
      const known = new Map(ids.map((id) => [id, /** @type {string} */ (ctls.get(id)?.snapshot().text)]));
      const { changed, failed: bad } = changedScenes(known, splitChapterDoc(doc, { only: ids }));
      for (const c of changed) {
        touched.add(c.sceneId);
        ctls.get(c.sceneId)?.edit(c.markdown);
        if (c.sceneId === cursorRef.current) latest.current.writing.setLiveBody(c.markdown);
      }
      const reasons = new Map(bad.map((f) => [f.sceneId, f.error]));
      for (const id of ids) {
        if (reasons.has(id)) failed.add(id);
        else failed.delete(id);
      }
      setErrors((p) => {
        const out = { ...p };
        for (const id of ids) {
          if (reasons.has(id)) out[id] = cannotSaveText(reasons.get(id));
          else delete out[id];
        }
        return out;
      });
    };

    const flushAll = async () => {
      serialize();
      const results = await Promise.all([...ctls.values()].map((c) => c.flush()));
      return { saved: results.every((r) => r.saved) && failed.size === 0 };
    };

    /** Replace one scene's text in the editor (a restored draft, the file's version after a conflict). */
    const applyScene = (id, text) => {
      const tr = replaceSceneTransaction(editor.state, id, text);
      if (tr) editor.view.dispatch(tr);
    };

    const goTo = (pos) => {
      editor.chain().focus().setTextSelection(pos).run();
      const dom = editor.view.nodeDOM(pos);
      const el = dom instanceof HTMLElement ? dom : editor.view.domAtPos(pos).node;
      (el instanceof HTMLElement ? el : el?.parentElement)?.scrollIntoView({ block: 'center' });
    };

    apiRef.current = { ctls, drafts, applyScene, flushAll, goTo };

    // ---- drafts and queued text left from an earlier visit, scene by scene
    for (const [id, ctl] of ctls) {
      const json = latest.current.loaded.get(id);
      const fileText = json.body;
      const key = draftKey(bookId, id);
      Promise.all([drafts.get(key), queue ? queue.get(bookId, id) : null]).then(([draft, entry]) => {
        if (cancelled) return;
        if (entry) {
          const what = entry.text === fileText ? 'none' : decideRestore(entry, json.sha256 ?? null);
          if (what === 'none') void queue.remove(bookId, id);
          else if (what === 'restore') {
            ctl.restoreDraft({ text: entry.text, base_sha256: entry.baseSha256 });
            applyScene(id, entry.text);
            setQueued((p) => ({ ...p, [id]: true }));
          } else void ctl.sendBuffered({ text: entry.text, baseSha256: entry.baseSha256 });
          return;
        }
        if (!draft) return;
        if (draft.text === fileText) {
          void drafts.clear(key);
          return;
        }
        const offer = draftOffer(draft, fileText);
        if (offer) setOffers((p) => ({ ...p, [id]: { text: offer.text, at: offer.at, base_sha256: offer.base_sha256 } }));
      });
    }

    // ---- editor events
    const onUpdate = () => {
      latest.current.writing.reportEdit();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(serialize, SERIALIZE_MS);
    };
    const onSelection = () => {
      const id = sceneAt(editor.state.doc, editor.state.selection.from);
      if (!id || id === cursorRef.current) return;
      cursorRef.current = id;
      setCursorScene(id);
      if (editor.isFocused) latest.current.onCursorScene?.(id);
    };
    const onBlur = () => {
      serialize();
      for (const ctl of ctls.values()) void ctl.blur();
    };
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onSelection);
    editor.on('blur', onBlur);

    // ---- the bridge: the inspector, the outline, Archive and the revision list talk to the open editor through it
    const scrollToCursorScene = () => {
      if (cursorRef.current) showScene(editor, cursorRef.current);
    };
    const unregister = bridge.register({
      get sceneId() {
        return cursorRef.current ?? '';
      },
      caretLine: () => null, // a line of one scene's Markdown has no meaning in the chapter view: "Split here" asks for a line instead
      flush: flushAll,
      isConflict: () => [...ctls.values()].some((c) => c.snapshot().state === 'conflict'),
      jumpToLine: scrollToCursorScene, // best effort: the start of the scene
      baseSha: () => ctls.get(cursorRef.current ?? '')?.snapshot().baseSha256 ?? null,
      text: () => ctls.get(cursorRef.current ?? '')?.snapshot().text ?? '',
      async reload() {
        let any = false;
        for (const [id, ctl] of ctls) {
          const before = ctl.snapshot().text;
          const r = await ctl.checkDisk();
          if (r.action === 'reload') {
            if (r.text !== before) applyScene(id, r.text);
            any = true;
          }
        }
        return { action: any ? 'reload' : 'ignored' };
      },
    });

    const onPageHide = () => {
      for (const ctl of ctls.values()) ctl.mirrorForUnload();
      if (!latest.current.can.readOnly) for (const id of touched) flushOnLeave(bookId, id, { keepalive: true });
    };
    const onBeforeUnload = (e) => {
      serialize();
      for (const ctl of ctls.values()) ctl.mirrorForUnload();
      if ([...ctls.values()].some((c) => c.needsPrompt()) || failed.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onKeyDown = (e) => {
      if (latest.current.shortcuts.matches(e, 'editor.save')) {
        e.preventDefault();
        serialize();
        for (const ctl of ctls.values()) void ctl.saveNow();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('keydown', onKeyDown);

    // ---- where to start: the scene the address names, with the cursor in it when it was just made
    const start = setTimeout(() => {
      const target = latest.current.activeId;
      if (target) showScene(editor, target, { focus: target === focusSceneId });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(start);
      unregister();
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onSelection);
      editor.off('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('keydown', onKeyDown);
      latest.current.writing.setLiveBody(null);
      // leaving: save every edited scene first (up to 3 s each); what does not finish stays in the draft store
      serialize();
      const done = () => {
        if (!latest.current.can.readOnly) for (const id of touched) flushOnLeave(bookId, id);
        for (const ctl of ctls.values()) ctl.dispose();
      };
      Promise.all([...ctls.values()].map((c) => c.flush())).then(done, done);
      apiRef.current = { ctls: new Map(), drafts: null, applyScene: () => {}, flushAll: async () => ({ saved: true }), goTo: () => {} };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one set of controllers per editor; later props are read through `latest`
  }, [editor, docProblem]);

  // ---- the address named another scene (the outline, the inspector): scroll to it. Moving the cursor into a scene sets the address first, so this does not fight it.
  useEffect(() => {
    if (!editor || !activeId || activeId === cursorRef.current) return;
    cursorRef.current = activeId;
    setCursorScene(activeId);
    showScene(editor, activeId);
  }, [editor, activeId]);

  // ---- the file may have changed outside (the book was reconciled and a scene came back with another hash)
  const shaKey = summaries.map((s) => `${s.id}:${s.sha256 ?? ''}`).join(',');
  const firstSha = useRef(true);
  useEffect(() => {
    if (firstSha.current) {
      firstSha.current = false;
      return;
    }
    for (const s of latest.current.summaries) {
      const ctl = apiRef.current.ctls.get(s.id);
      if (!ctl || !s.sha256 || s.sha256 === ctl.snapshot().baseSha256) continue;
      const before = ctl.snapshot().text;
      void ctl.checkDisk().then((r) => {
        if (r.action === 'reload' && r.text !== before) {
          apiRef.current.applyScene(s.id, r.text);
          setNotice(s.id, 'Updated from disk');
        }
      });
    }
  }, [shaKey, setNotice]);

  // ---- tell the top bar what the chapter is doing, as one state
  useEffect(() => {
    const all = [...Object.values(snaps), ...(Object.keys(errors).length > 0 ? [{ state: /** @type {const} */ ('error'), savedAt: null }] : [])];
    const agg = aggregateSaveState(all);
    if (agg) setEditor({ bookId: book.id, state: agg.state, savedAt: agg.savedAt });
  }, [snaps, errors, book.id, setEditor]);
  useEffect(() => () => setEditor(null), [setEditor]);

  // a conflict must be seen: nothing else to do for it here (the panel is under the scene's break)
  const others = usePresence({ bookId: book.id, sceneId: cursorScene ?? '', enabled: can.present && cursorScene !== null });
  const structure = useStructure({ book, activeId: cursorScene, onChanged: onStructureChanged });

  // ---- actions of the scene breaks (created once; they read the current state through refs)
  const actions = useMemo(() => {
    const api = () => apiRef.current;
    const fieldsUrl = (id) => bookUrl(latest.current.book.id, `/scenes/${encodeURIComponent(id)}/fields`);
    /** After a front-matter write the file has a new hash: read it, so the next save uses it as its base. */
    const syncBase = async (id) => {
      const ctl = api().ctls.get(id);
      if (!ctl) return;
      const before = ctl.snapshot().text;
      const r = await ctl.checkDisk();
      if (r.action === 'reload' && r.text !== before) api().applyScene(id, r.text);
    };
    const writeField = async (id, body, failure) => {
      const ctl = api().ctls.get(id);
      if (ctl) {
        const { saved } = await api().flushAll();
        if (!saved) {
          setNotice(id, `${failure}: the chapter has text that could not be saved yet.`);
          return false;
        }
      }
      const { status, json } = await latest.current.track(latest.current.book.id, () => send(fieldsUrl(id), body));
      if (status !== 200) {
        setNotice(id, `${failure}: ${explainFailure(status, json)}`);
        return false;
      }
      await syncBase(id);
      latest.current.onStructureChanged?.();
      return true;
    };
    const ctlOf = (id) => api().ctls.get(id);
    return {
      async renameScene(id, title) {
        const base = latest.current.summaries.find((s) => s.id === id)?.title ?? '';
        if (await writeField(id, { title }, 'Not renamed')) setTitleOverride((p) => ({ ...p, [id]: { value: title, base } }));
      },
      async saveSummary(id, summary) {
        if (await writeField(id, { summary }, 'Summary not saved')) setSummaryOf((p) => ({ ...p, [id]: summary }));
      },
      toggleNotes(id) {
        const open = notesOpenRef.current[id] !== true;
        const next = { ...notesOpenRef.current };
        if (open) next[id] = true;
        else delete next[id];
        notesOpenRef.current = next;
        writeNotesOpen(storage(), id, open);
        setNotesOpen(next);
      },
      goToNote: (pos) => api().goTo(pos),
      retry: (id) => void ctlOf(id)?.saveNow(),
      checkDisk(id) {
        const ctl = ctlOf(id);
        if (!ctl) return;
        const before = ctl.snapshot().text;
        void ctl.checkDisk().then((r) => {
          if (r.action === 'reload' && r.text !== before) api().applyScene(id, r.text);
        });
      },
      async keepMine(id) {
        await ctlOf(id)?.keepMine();
      },
      async useFile(id) {
        const r = await ctlOf(id)?.adoptDisk();
        if (r?.ok) {
          api().applyScene(id, r.text);
          setNotice(id, "Showing the file's version. Your text is kept in Discarded drafts for 7 days (open the source to find it).");
        } else setNotice(id, "The file's version could not be read. Your text is still here.");
      },
      async useTheirs(id) {
        const ctl = ctlOf(id);
        const kept = ctl?.snapshot().conflict?.suggestionId != null;
        const r = await ctl?.adoptDisk({ preserve: !kept });
        if (r?.ok) {
          api().applyScene(id, r.text);
          setNotice(id, kept ? 'Showing their version. Your text is kept as a suggestion in the side panel.' : 'Showing their version. Your text is kept in Discarded drafts for 7 days.');
        } else setNotice(id, 'Their version could not be read. Your text is still here.');
      },
      async saveCopy(id) {
        const ctl = ctlOf(id);
        const json = latest.current.loaded.get(id);
        if (!ctl) return { ok: false, message: 'The editor is not ready.' };
        const title = `${latest.current.summaries.find((s) => s.id === id)?.title || 'Untitled scene'} (my version)`;
        const { status, json: made } = await send(bookUrl(latest.current.book.id, '/scenes'), { chapter: json?.chapter, act: json?.act, after: id, title, slug: slugify(title), body: ctl.snapshot().text });
        if (status !== 201 || !made?.id) {
          return { ok: false, message: status === 0 ? 'The server could not be reached. Nothing was copied.' : `The copy could not be made (${made?.code ?? status}). Your text is still here.` };
        }
        const r = await ctl.adoptDisk({ preserve: false });
        if (r.ok) api().applyScene(id, r.text);
        setNotice(id, `Saved your text as a new scene, "${title}".`);
        latest.current.onStructureChanged?.(made);
        return { ok: true, id: made.id };
      },
      review: (id) => setReviewId(ctlOf(id)?.snapshot().conflict?.suggestionId ?? null),
      restoreOffer(id) {
        const ctl = ctlOf(id);
        const offer = offersRef.current[id];
        if (!ctl || !offer) return;
        const result = ctl.restoreDraft({ text: offer.text, base_sha256: offer.base_sha256 ?? null });
        api().applyScene(id, offer.text);
        if (result === 'conflict') setNotice(id, 'The file changed since this draft was made. Choose what to keep.');
        setOffers((p) => without(p, id));
      },
      discardOffer(id) {
        void api().drafts?.discard(draftKey(latest.current.book.id, id));
        setOffers((p) => without(p, id));
      },
      dismissNotice: (id) => setNotices((p) => without(p, id)),
    };
  }, [setNotice]);

  const value = useMemo(() => {
    const scenes = Object.fromEntries(
      summaries.map((s) => {
        const ov = titleOverride[s.id];
        const json = loaded.get(s.id);
        return [s.id, { title: ov && ov.base === (s.title ?? '') ? ov.value : (s.title ?? ''), summary: summaryOf[s.id] ?? '', sourceHref: sourceHref(book.id, s.id), problem: json?.problem ?? null }];
      }),
    );
    return { bookId: book.id, canEdit: !can.readOnly, canReview: can.comment, canDecide: can.decide, scenes, snaps, errors, notices, offers, queued, notes, notesOpen, actions };
  }, [book.id, summaries, loaded, titleOverride, summaryOf, can.readOnly, can.comment, can.decide, snaps, errors, notices, offers, queued, notes, notesOpen, actions]);

  const addScene = async () => {
    const { saved } = await apiRef.current.flushAll();
    const after = cursorRef.current ?? summaries[summaries.length - 1]?.id ?? null;
    if (!saved) {
      if (after) setNotice(after, 'Not added: the chapter has text that could not be saved yet. Resolve that first.');
      return;
    }
    structure.start({ type: 'add-scene', chapter: chapter.chapter, act, after });
  };

  if (docProblem) {
    return (
      <section className="editor-notice editor-notice-danger" role="alert">
        <p>
          <strong>This chapter can't be shown in the editor.</strong> Nothing was changed. Open a scene in the source editor instead.
        </p>
        <p>
          {summaries.map((s) => (
            <Link key={s.id} to={sourceHref(book.id, s.id)} className="btn row-button">
              {s.title || 'Untitled scene'}
            </Link>
          ))}
        </p>
      </section>
    );
  }

  const after = summaries.find((s) => s.id === cursorScene);
  return (
    <div className="editor-column sf-chapter">
      <header className="sf-chapter-head">
        <h1 className="sf-chapter-title">{chapterLabel ?? chapter.label}</h1>
        <button type="button" className="btn btn-small" onClick={addScene} disabled={can.readOnly} title={after ? `A new scene after "${after.title || 'Untitled scene'}"` : 'A new scene'}>
          New scene
        </button>
      </header>
      <ChapterToolbar editor={editor} disabled={can.readOnly} />
      <PresenceNote users={others} />
      <ChapterContext.Provider value={value}>
        <article className="paper editor-paper sf-chapter-paper">
          <EditorContent editor={editor} />
        </article>
      </ChapterContext.Provider>
      {reviewId && <SuggestionDialog key={reviewId} bookId={book.id} suggestionId={reviewId} version={String(Object.keys(snaps).length)} actions={suggestionActions} canDecide={can.decide} onClose={() => setReviewId(null)} />}
      {suggestionActions.ui}
      {structure.ui}
    </div>
  );
}
