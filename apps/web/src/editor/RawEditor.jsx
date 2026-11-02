// The raw-file escape hatch: the whole scene file (front matter and body) in a plain editor, so an author can fix
// front matter by hand. The server only keeps the change if the book has no new errors afterwards.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import { putJson } from '../api.js';
import { DiagnosticList } from '../shell/Inspector.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { bookUrl, pathsOf } from '../structure/helpers.js';
import { detectLineEnding, loadBuffer, serialise } from './buffer.js';
import { plainSurface } from './extensions.js';

/**
 * @param {{ book: any, scene: any, onClose: () => void, onSaved: (info: any) => void }} props
 */
export function RawEditorDialog({ book, scene, onClose, onSaved }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const saveRef = useRef(() => {});
  const [loaded, setLoaded] = useState(null); // { text, sha256 } once read
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null); // { message, diagnostics }
  const mixed = loaded ? detectLineEnding(loaded.text).kind === 'mixed' : false;
  const relPath = pathsOf(book, scene.path).bookRel;

  useEffect(() => {
    let cancelled = false;
    fetch(bookUrl(book.id, `/raw?path=${encodeURIComponent(relPath)}`), { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((raw) => {
        if (!cancelled) setLoaded({ text: raw.body, sha256: raw.sha256 });
      })
      .catch(() => {
        if (!cancelled) setLoadError('The file could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [book.id, relPath]);

  useEffect(() => {
    if (!loaded || !hostRef.current) return undefined;
    const { state } = loadBuffer(loaded.text, [
      plainSurface(),
      history(),
      keymap.of([{ key: 'Mod-s', run: () => (saveRef.current(), true), preventDefault: true }, ...historyKeymap, ...defaultKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': 'Whole scene file', spellcheck: 'false' }),
    ]);
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [loaded]);

  async function save() {
    const view = viewRef.current;
    if (!view || !loaded || busy || mixed) return;
    setBusy(true);
    setProblem(null);
    let status = 0;
    let json = null;
    try {
      ({ status, json } = await putJson(bookUrl(book.id, `/scenes/${encodeURIComponent(scene.id)}/raw`), { content: serialise(view.state), base_sha256: loaded.sha256 }));
    } catch {
      // the server could not be reached: status stays 0
    }
    setBusy(false);
    if (status === 200) {
      onSaved(json);
      onClose();
    } else if (status === 422) {
      setProblem({ message: 'Not saved: this change would add problems to the book, so the file was left as it was.', diagnostics: json?.diagnostics ?? [] });
    } else if (status === 409) {
      setProblem({ message: 'Not saved: the file changed on disk after you opened it. Close this window and open it again; nothing was overwritten.', diagnostics: [] });
    } else if (status === 0) {
      setProblem({ message: 'Not saved: the server could not be reached.', diagnostics: [] });
    } else {
      setProblem({ message: `Not saved (${json?.code ?? status}).`, diagnostics: [] });
    }
  }
  useEffect(() => {
    saveRef.current = save;
  });

  return (
    <Dialog label={`Edit raw file: ${scene.title}`} onClose={onClose} className="raw-dialog">
      <h2>Edit raw file</h2>
      <p className="muted">
        <code>{relPath}</code>
      </p>
      <p className="raw-warning">You are editing the whole file, including its front matter. StoryForge checks the book before keeping your change; if it would add problems, nothing is saved.</p>
      {loadError && <p className="error">{loadError}</p>}
      {!loaded && !loadError && <p className="muted">Loading…</p>}
      {mixed && <p className="error">This file mixes line endings, so it is read-only here. Normalise it from the scene editor first.</p>}
      <div className="raw-surface" ref={hostRef} />
      {problem && (
        <div role="alert">
          <p className="error">{problem.message}</p>
          {problem.diagnostics.length > 0 && <DiagnosticList items={problem.diagnostics} />}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={!loaded || busy || mixed}>
          Save
        </button>
      </div>
    </Dialog>
  );
}
