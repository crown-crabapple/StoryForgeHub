// The centre column for one scene: title, meta line, formatting toolbar and the CodeMirror editor, with the
// autosave / conflict / offline behaviour of save-controller.js. The buffer is the scene body only.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookUrl, send, slugify } from '../structure/helpers.js';
import { useEditorBridge } from './bridge.jsx';
import { caretLine, detectLineEnding, loadBuffer, normaliseLineEndings, normalisePreview, serialise } from './buffer.js';
import { authorNote, bold, insertLink, italic, sceneBreak } from './commands.js';
import { ConflictPanel } from './ConflictPanel.jsx';
import { createDraftStore, draftKey } from './draft-store.js';
import { decoratedMarkdown, marksExtension, setMarks } from './extensions.js';
import { LinkPicker } from './LinkPicker.jsx';
import { nameIndex } from './names.js';
import { createSaveController, draftOffer } from './save-controller.js';
import { EditorToolbar } from './Toolbar.jsx';
import { countWords, describeCount, selectionWords } from './wordcount.js';

const MARKS_KEY = 'storyforge.showMarks';

/** The "Show Markdown marks" choice, remembered per user in localStorage (every access guarded). */
const readShowMarks = () => {
  try {
    return globalThis.localStorage?.getItem(MARKS_KEY) !== 'false';
  } catch {
    return true;
  }
};
const writeShowMarks = (show) => {
  try {
    globalThis.localStorage?.setItem(MARKS_KEY, String(show));
  } catch {
    // not remembered; the toggle still works for this visit
  }
};

const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** @param {{ title: string, children: import('react').ReactNode, onClose: () => void, actions: import('react').ReactNode }} props */
function InfoDialog({ title, children, onClose, actions }) {
  return (
    <Dialog label={title} onClose={onClose}>
      <h2>{title}</h2>
      {children}
      <div className="dialog-actions">{actions}</div>
    </Dialog>
  );
}

/**
 * @param {{ book: any, scene: any, chapterLabel?: string | null, objects?: any[] | null, footerExtra?: import('react').ReactNode,
 *   onStructureChanged?: (info?: any) => void }} props
 *   Render with `key={scene.id}`: one editor (and one save controller) per open scene. `scene` is the GET scene answer; when its
 *   `sha256` changes later (the book was reconciled) the editor asks the server whether the file changed outside.
 */
export function SceneEditorPage({ book, scene, chapterLabel = null, objects = null, footerExtra = null, onStructureChanged }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const ctlRef = useRef(null);
  const draftsRef = useRef(null);
  const extensionsRef = useRef(null);
  const pickerRef = useRef(() => {});
  const firstSha = useRef(true);
  const bridge = useEditorBridge();
  const { setEditor } = useWrites();
  const key = draftKey(book.id, scene.id);

  const [snap, setSnap] = useState(null);
  const [words, setWords] = useState(() => countWords(scene.body ?? ''));
  const [selected, setSelected] = useState(0);
  const [lineKind, setLineKind] = useState(() => detectLineEnding(scene.body ?? '').kind);
  const [pickerText, setPickerText] = useState('');
  const [showMarks, setShowMarks] = useState(readShowMarks);
  const [offer, setOffer] = useState(null);
  const [discarded, setDiscarded] = useState([]);
  const [dialog, setDialog] = useState(null); // 'picker' | 'normalise' | 'discarded' | 'keep-mine'
  const [note, setNote] = useState(null);
  const [copied, setCopied] = useState(null);
  const showMarksRef = useRef(showMarks);
  const noteTimer = useRef(null);
  const names = nameIndex(objects);

  const flash = useCallback((message, { sticky = false } = {}) => {
    clearTimeout(noteTimer.current);
    setNote(message);
    if (!sticky) noteTimer.current = setTimeout(() => setNote(null), 5000);
  }, []);

  const refreshDiscarded = useCallback(async () => {
    const list = await draftsRef.current?.listDiscarded(key).catch(() => []);
    setDiscarded(list ?? []);
  }, [key]);

  /** Replace the whole buffer (reload, restore, normalise). The undo history starts fresh. */
  const applyText = useCallback((text, { keepLine = false } = {}) => {
    const view = viewRef.current;
    if (!view) return;
    const line = caretLine(view.state);
    const { state, lineEndings } = loadBuffer(text, extensionsRef.current);
    view.setState(state);
    view.dispatch({ effects: setMarks(showMarksRef.current) });
    setLineKind(lineEndings.kind);
    setWords(countWords(text));
    setSelected(0);
    if (keepLine) {
      const at = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
      view.dispatch({ selection: { anchor: at } });
    }
  }, []);

  // ---- the editor, the save controller and the draft store live and die with this scene
  useEffect(() => {
    const drafts = createDraftStore();
    const fileText = scene.body ?? '';
    const ctl = createSaveController({ bookId: book.id, sceneId: scene.id, text: fileText, sha256: scene.sha256 ?? null, drafts, onChange: setSnap });
    draftsRef.current = drafts;
    ctlRef.current = ctl;

    const runCommand = (cmd) => () => {
      const view = viewRef.current;
      return view ? cmd(view) : false;
    };
    const extensions = [
      history(),
      keymap.of([
        { key: 'Mod-b', run: runCommand(bold), preventDefault: true },
        { key: 'Mod-i', run: runCommand(italic), preventDefault: true },
        { key: 'Mod-k', run: () => (pickerRef.current(), true), preventDefault: true },
        { key: 'Mod-Alt-m', run: runCommand(authorNote), preventDefault: true },
        { key: 'Mod-Enter', run: runCommand(sceneBreak), preventDefault: true },
        { key: 'Mod-s', run: () => (void ctl.saveNow(), true), preventDefault: true },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      decoratedMarkdown(),
      marksExtension(readShowMarks()),
      placeholder('Start writing…'),
      // pasted text takes the file's own line ending, so a CRLF scene never gains a bare LF
      EditorView.clipboardInputFilter.of((text, state) => text.replace(/\r\n|\r|\n/g, state.lineBreak)),
      EditorView.contentAttributes.of({ 'aria-label': 'Scene text', spellcheck: 'true' }),
      EditorView.contentAttributes.compute([EditorState.readOnly], (state) => (state.facet(EditorState.readOnly) ? { 'aria-readonly': 'true' } : {})),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const text = serialise(u.state);
          ctl.edit(text);
          setWords(countWords(text));
        }
        if (u.docChanged || u.selectionSet) setSelected(selectionWords(u.state));
      }),
      EditorView.domEventHandlers({
        blur: () => {
          void ctl.blur();
        },
      }),
    ];
    extensionsRef.current = extensions;
    const { state } = loadBuffer(fileText, extensions);
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    let cancelled = false;
    drafts.get(key).then((draft) => {
      if (cancelled || !draft) return;
      if (draft.text === fileText) {
        void drafts.clear(key); // a leftover of a save that did land
        return;
      }
      setOffer(draftOffer(draft, fileText));
    });
    drafts.listDiscarded(key).then((list) => {
      if (!cancelled) setDiscarded(list);
    });

    const unregister = bridge.register({ sceneId: scene.id, caretLine: () => (viewRef.current ? caretLine(viewRef.current.state) : null), flush: () => ctl.flush() });
    const onPageHide = () => ctl.mirrorForUnload();
    const onBeforeUnload = (e) => {
      ctl.mirrorForUnload();
      if (ctl.needsPrompt()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void ctl.saveNow();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelled = true;
      unregister();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('keydown', onKeyDown);
      // leaving: save first (up to 3 s); if that does not finish the draft is kept
      const done = () => ctl.dispose();
      ctl.flush().then(done, done);
      view.destroy();
      viewRef.current = null;
      ctlRef.current = null;
      clearTimeout(noteTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one editor per scene id; later `scene` props are handled below
  }, [book.id, scene.id]);

  // ---- tell the top bar what the editor is doing
  useEffect(() => {
    if (snap) setEditor({ bookId: book.id, state: snap.state, savedAt: snap.savedAt });
  }, [snap, book.id, setEditor]);
  useEffect(() => () => setEditor(null), [setEditor]);

  // ---- the file may have changed outside (the book was reconciled and the scene came back with another hash)
  useEffect(() => {
    if (firstSha.current) {
      firstSha.current = false;
      return;
    }
    const ctl = ctlRef.current;
    if (!ctl || scene.sha256 === ctl.snapshot().baseSha256) return;
    ctl.checkDisk().then((r) => {
      if (r.action === 'reload') {
        applyText(r.text, { keepLine: true });
        flash('Updated from disk');
      }
    });
  }, [scene.sha256, applyText, flash]);

  // ---- toolbar and picker
  const runCmd = (cmd) => {
    const view = viewRef.current;
    if (!view) return;
    cmd(view);
    view.focus();
  };
  const openPicker = useCallback(() => {
    const view = viewRef.current;
    const r = view?.state.selection.main;
    setPickerText(view && r ? view.state.sliceDoc(r.from, r.to) : '');
    setDialog('picker');
  }, []);
  useEffect(() => {
    pickerRef.current = () => {
      if (!viewRef.current?.state.readOnly) openPicker();
    };
  }, [openPicker]);
  const pick = (slug) => {
    setDialog(null);
    const view = viewRef.current;
    if (!view) return;
    insertLink(slug)(view);
    view.focus();
  };
  const toggleMarks = () => {
    const next = !showMarks;
    setShowMarks(next);
    showMarksRef.current = next;
    writeShowMarks(next);
    viewRef.current?.dispatch({ effects: setMarks(next) });
  };

  // ---- draft banner
  const restoreDraftNow = () => {
    const ctl = ctlRef.current;
    if (!ctl || !offer) return;
    const result = ctl.restoreDraft(offer);
    applyText(offer.text);
    setOffer(null);
    if (result === 'conflict') flash('The file changed since this draft was made. Choose what to keep.', { sticky: true });
  };
  const discardDraftNow = async () => {
    await draftsRef.current?.discard(key);
    setOffer(null);
    await refreshDiscarded();
  };
  const restoreDiscarded = async (d) => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    ctl.restoreDraft(d);
    applyText(d.text);
    await draftsRef.current?.removeDiscarded(key, d.discarded_at);
    setDialog(null);
    await refreshDiscarded();
  };

  // ---- conflict choices
  const keepMine = async () => {
    setDialog(null);
    await ctlRef.current?.keepMine();
  };
  const useFile = async () => {
    const r = await ctlRef.current?.adoptDisk();
    if (r?.ok) {
      applyText(r.text);
      await refreshDiscarded();
      flash("Showing the file's version. Your text is kept in Discarded drafts for 7 days.");
    } else flash("The file's version could not be read. Your text is still here.", { sticky: true });
  };
  const saveCopy = async () => {
    const ctl = ctlRef.current;
    if (!ctl) return { ok: false, message: 'The editor is not ready.' };
    const text = ctl.snapshot().text;
    const title = `${scene.title || 'Untitled scene'} (my version)`;
    const { status, json } = await send(bookUrl(book.id, '/scenes'), {
      chapter: scene.chapter,
      act: scene.act,
      after: scene.id,
      title,
      slug: slugify(title),
      body: text,
    });
    if (status !== 201 || !json?.id) {
      return { ok: false, message: status === 0 ? 'The server could not be reached. Nothing was copied.' : `The copy could not be made (${json?.code ?? status}). Your text is still here.` };
    }
    onStructureChanged?.(json);
    const r = await ctl.adoptDisk({ preserve: false });
    if (r.ok) applyText(r.text);
    flash(`Saved your text as a new scene, "${title}". `, { sticky: true });
    setCopied({ id: json.id, title });
    return { ok: true };
  };
  // ---- mixed line endings
  const normalise = async () => {
    const ctl = ctlRef.current;
    const view = viewRef.current;
    if (!ctl || !view) return;
    const text = serialise(view.state);
    const { target } = normalisePreview(text);
    const next = normaliseLineEndings(text, target);
    setDialog(null);
    applyText(next);
    ctl.edit(next);
    await ctl.saveNow();
    flash(`Line endings normalised to ${target === '\r\n' ? 'CRLF' : 'LF'}.`);
  };

  const state = snap?.state ?? 'clean';
  const mixed = lineKind === 'mixed';
  const pov = scene.pov ? names.nameOf(scene.pov) : null;
  const meta = [chapterLabel, scene.status ?? 'no status', pov ? `POV ${pov}` : null, `${words} ${words === 1 ? 'word' : 'words'}`].filter(Boolean);
  const preview = mixed ? normalisePreview(snap?.text ?? scene.body ?? '') : null;

  return (
    <div className="editor-column">
      <EditorToolbar
        onBold={() => runCmd(bold)}
        onItalic={() => runCmd(italic)}
        onLink={() => pickerRef.current()}
        onNote={() => runCmd(authorNote)}
        onSceneBreak={() => runCmd(sceneBreak)}
        showMarks={showMarks}
        onToggleMarks={toggleMarks}
        disabled={mixed}
      />
      {mixed && (
        <section className="editor-notice" role="region" aria-label="Mixed line endings">
          <p>
            <strong>This scene mixes line endings, so it is read-only.</strong> Some lines end one way and some another; editing it could change lines you did not touch.
          </p>
          <button type="button" className="btn" onClick={() => setDialog('normalise')}>
            Normalise line endings…
          </button>
        </section>
      )}
      {offer && state !== 'conflict' && (
        <section className="editor-notice" role="region" aria-label="Unsaved changes found">
          <p>You have unsaved changes from {formatTime(offer.at)}.</p>
          <div className="editor-notice-actions">
            <button type="button" className="btn btn-primary" onClick={restoreDraftNow}>
              Restore
            </button>
            <button type="button" className="btn" onClick={discardDraftNow}>
              Discard
            </button>
          </div>
        </section>
      )}
      {state === 'conflict' && snap && (
        <ConflictPanel
          snapshot={snap}
          title={scene.title}
          onCheckDisk={() => ctlRef.current?.checkDisk()}
          onKeepMine={() => setDialog('keep-mine')}
          onUseFile={useFile}
          onSaveCopy={saveCopy}
        />
      )}
      {state === 'error' && snap?.error && (
        <section className="editor-notice editor-notice-danger" role="alert">
          <p>
            <strong>This scene could not be saved</strong> (the server answered {snap.error.status}). Your text is kept here and in this browser.
          </p>
          <button type="button" className="btn" onClick={() => ctlRef.current?.saveNow()}>
            Try again
          </button>
        </section>
      )}
      {state === 'offline' && (
        <p className="editor-offline" role="status">
          Can't reach StoryForge — retrying. Keep writing; your text is kept in this browser.{' '}
          <button type="button" className="btn row-button" onClick={() => ctlRef.current?.saveNow()}>
            Retry now
          </button>
        </p>
      )}
      {note && (
        <p className="editor-flash" role="status">
          {note}
          {copied && (
            <>
              {' '}
              <Link to={`/books/${encodeURIComponent(book.id)}?scene=${encodeURIComponent(copied.id)}`}>Open it</Link>
            </>
          )}
        </p>
      )}
      <article className="paper editor-paper">
        <h1>{scene.title}</h1>
        <p className="paper-meta">{meta.join(' · ')}</p>
        <div className="editor-surface" ref={hostRef} />
        <footer className="paper-footer">
          <span className="muted" aria-live="polite">
            {describeCount(words, selected)}
          </span>
          <span className="editor-footer-actions">
            {discarded.length > 0 && (
              <button type="button" className="btn row-button" onClick={() => setDialog('discarded')}>
                Discarded drafts ({discarded.length})
              </button>
            )}
            {footerExtra}
          </span>
        </footer>
      </article>

      {dialog === 'picker' && <LinkPicker objects={objects} selectedText={pickerText} onPick={pick} onClose={() => setDialog(null)} />}
      {dialog === 'normalise' && preview && (
        <InfoDialog
          title="Normalise line endings"
          onClose={() => setDialog(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={normalise}>
                Normalise and save
              </button>
            </>
          }
        >
          <p>
            {preview.changing} of {preview.total} line endings will change to {preview.target === '\r\n' ? 'CRLF (Windows)' : 'LF (Unix)'}, the ending most lines already use. Nothing else in the text
            changes. The scene is saved once.
          </p>
        </InfoDialog>
      )}
      {dialog === 'keep-mine' && (
        <InfoDialog
          title="Keep your version?"
          onClose={() => setDialog(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={keepMine}>
                Overwrite the file
              </button>
            </>
          }
        >
          <p>This replaces the version on disk with the text in the editor.</p>
        </InfoDialog>
      )}
      {dialog === 'discarded' && (
        <InfoDialog
          title="Discarded drafts"
          onClose={() => setDialog(null)}
          actions={
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Close
            </button>
          }
        >
          <p className="muted">Text you chose not to keep is held here for 7 days.</p>
          <ul className="picker-list">
            {discarded.map((d) => (
              <li key={d.discarded_at} className="discarded-item">
                <span>
                  {formatTime(d.at)} · {d.text.slice(0, 80).replace(/\s+/g, ' ')}
                  {d.text.length > 80 ? '…' : ''}
                </span>
                <button type="button" className="btn row-button" onClick={() => restoreDiscarded(d)}>
                  Restore into the editor
                </button>
              </li>
            ))}
          </ul>
        </InfoDialog>
      )}
    </div>
  );
}
