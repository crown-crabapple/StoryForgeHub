import { useEffect, useRef, useState } from 'react';
import { useEditorBridge } from '../editor/bridge.jsx';
import { RawEditorDialog } from '../editor/RawEditor.jsx';
import { useNavigate } from '../router.jsx';
import { RepairDialog } from '../RepairDialog.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { useWrites } from '../shell/writes.jsx';
import { MoveDialog } from './MoveDialog.jsx';
import { PreviewDialog } from './PreviewDialog.jsx';
import { bookUrl, explainFailure, pathsOf, send, slugify } from './helpers.js';

const TOAST_MS = 12000;

/** One small form in a dialog. `fields`: [{ name, label, type?: 'text' | 'number' | 'checkbox', initial?, hint?, required? }]. */
function FormDialog({ form, onSubmit, onClose, busy }) {
  const [values, setValues] = useState(() => Object.fromEntries(form.fields.map((f) => [f.name, f.initial ?? (f.type === 'checkbox' ? false : '')])));
  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <Dialog label={form.title} onClose={onClose}>
      <h2>{form.title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(values);
        }}
      >
        {form.fields.map((f) => (
          <div key={f.name} className={f.type === 'checkbox' ? 'form-row form-check' : 'form-row'}>
            <label>
              {f.type === 'checkbox' ? null : <span className="form-label">{f.label}</span>}
              {f.type === 'checkbox' ? (
                <input type="checkbox" name={f.name} checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />
              ) : (
                <input
                  type={f.type ?? 'text'}
                  name={f.name}
                  value={values[f.name]}
                  onChange={(e) => set(f.name, e.target.value)}
                  required={f.required}
                  autoComplete="off"
                  {...(f.type === 'number' ? { min: 1, step: 1 } : {})}
                />
              )}
              {f.type === 'checkbox' ? <span> {f.label}</span> : null}
            </label>
            {f.hint && <p className="muted form-hint">{f.hint}</p>}
          </div>
        ))}
        {form.error && (
          <p role="alert" className="error">
            {form.error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {form.submit ?? 'Continue'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The message under a finished write; Undo is offered when the server kept a trash copy to restore from. */
function Toast({ toast, onUndo, onDismiss }) {
  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.opId && (
        <button type="button" className="btn toast-button" onClick={onUndo}>
          Undo
        </button>
      )}
      <button type="button" className="btn toast-button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

const sceneName = (s) => s.title || 'Untitled scene';

/**
 * The structure commands of the manuscript tree: forms, the Preview dialog, applying, and the Undo toast.
 * Returns `start(command)` and `ui` (the dialogs and the toast, rendered once next to the tree).
 * Every write goes through a dry run and the Preview, except a scene's rename-without-file-rename and its
 * status, which are single-line edits: those apply at once and offer Undo in the toast.
 * `move(scene, target)` (drag and drop, Alt+Up/Down, the Move... dialog) flushes the open editor, asks the server for a dry run, and
 * applies at once when only the moved scene's file changes (toast with Undo = restore of the operation) or opens the Preview when neighbours are
 * renumbered. `onMoved(sceneId, target)` runs after a move was written.
 * `apply(cmd)` and `preview(cmd, { stayInForm })` are the same two paths for any other write command `{ title, url, body, done, undoable?, after? }` (the
 * Board, Outline and Threads views use them): `apply` writes at once and offers Undo; `preview` shows the dry-run diff first.
 * @param {{ book: any, activeId?: string | null, onChanged?: (info: any) => void, onMoved?: (sceneId: string, target: any) => void }} p
 */
export function useStructure({ book, activeId = null, onChanged, onMoved }) {
  const { track } = useWrites();
  const navigate = useNavigate();
  const bridge = useEditorBridge();
  const [raw, setRaw] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [moveDialog, setMoveDialog] = useState(null);
  const [repairing, setRepairing] = useState(false);
  const moving = useRef(false);
  const bookId = book.id;
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const showToast = (next) => {
    clearTimeout(timer.current);
    setToast(next);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  };
  const write = (url, body) => track(bookId, () => send(url, body));
  const sceneUrl = (id, tail = '') => bookUrl(bookId, `/scenes/${encodeURIComponent(id)}${tail}`);
  const toBook = () => navigate(`/books/${encodeURIComponent(bookId)}`);
  const toScene = (json) => {
    if (json?.id) navigate(`/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(json.id)}`);
  };

  /** POST a command for real. @returns {Promise<{ ok: true } | { ok: false, message: string }>} */
  async function applyNow(cmd) {
    const { status, json } = await write(cmd.url, cmd.body);
    if (status === 200 || status === 201) {
      showToast({
        message: cmd.done,
        opId: cmd.undoable ? (json?.opId ?? null) : null,
      });
      onChanged?.(json);
      cmd.after?.(json);
      return { ok: true };
    }
    return { ok: false, message: explainFailure(status, json) };
  }

  /**
   * Dry run, then the Preview. A refusal opens the Preview with the reason (a "no gap" refusal offers
   * Renumber), or, with `stayInForm`, is returned so the form can show it and stay editable.
   */
  async function previewThenApply(cmd, { stayInForm = false } = {}) {
    setBusy(true);
    const { status, json } = await write(cmd.url, { ...cmd.body, dryRun: true });
    setBusy(false);
    if (status !== 200) {
      const message = explainFailure(status, json);
      if (stayInForm) return { error: message };
      setForm(null);
      setPreview({
        title: cmd.title,
        error: message,
        changes: [],
        extraAction: json?.code === 'NO_CHAPTER_GAP' ? { label: 'Renumber chapters...', run: () => startRef.current({ type: 'renumber' }) } : null,
      });
      return undefined;
    }
    setForm(null);
    const notes = json?.not_merged?.length
      ? [{ heading: 'These fields of the second scene are not merged. Copy them by hand if you want them:', items: json.not_merged.map((n) => n.text) }]
      : [];
    setPreview({ title: cmd.title, changes: json?.changes ?? [], notes, cmd });
    return undefined;
  }
  const startRef = useRef(null);
  useEffect(() => {
    startRef.current = start;
  });

  /** A Preview whose files are known without asking the server (archive and restore of one scene). */
  const localPreview = (title, changes, run) => setPreview({ title, changes, cmd: { local: run } });

  async function submitForm(values) {
    if (!form) return;
    setBusy(true);
    const r = await form.onSubmit(values);
    setBusy(false);
    if (r?.error) setForm((f) => (f ? { ...f, error: r.error } : f));
    else if (r?.close) setForm(null);
  }

  async function apply() {
    if (!preview?.cmd) return;
    setBusy(true);
    const r = preview.cmd.local ? await preview.cmd.local() : await applyNow(preview.cmd);
    setBusy(false);
    if (r.ok) setPreview(null);
    else setPreview({ ...preview, error: r.message });
  }

  /**
   * Move one scene. Flushes the open editor first (J02) and refuses while the open scene is in conflict. A failure is returned as
   * `{ error, repair? }` for the Move... dialog (`fromDialog`), else shown in the Preview dialog / a toast.
   * @returns {Promise<{ ok: boolean, error?: string, repair?: boolean }>}
   */
  async function move(scene, target, { fromDialog = false, done } = {}) {
    if (moving.current) return { ok: false, error: 'Another move is still in progress.' };
    moving.current = true;
    try {
      const name = sceneName(scene);
      const blocked = (message) => {
        if (!fromDialog) showToast({ message });
        return { ok: false, error: message };
      };
      const fail = (message, repair = false) => {
        if (fromDialog) return { ok: false, error: message, repair };
        setPreview({
          title: `Move "${name}"`,
          error: message,
          changes: [],
          extraAction: repair
            ? {
                label: 'Repair...',
                run: () => {
                  setPreview(null);
                  setRepairing(true);
                },
              }
            : null,
        });
        return { ok: false, error: message };
      };
      const open = bridge.current();
      if (open) {
        if (open.isConflict?.()) return blocked('Not moved: the open scene has a conflict with the file on disk. Resolve that first.');
        const { saved } = await open.flush();
        if (!saved) return blocked('Not moved: the open scene has changes that could not be saved yet. Resolve that first.');
      }
      const body = { chapter: target.chapter, act: target.act, after: target.after };
      const url = sceneUrl(scene.id, '/move');
      setBusy(true);
      const dry = await write(url, { ...body, dryRun: true });
      setBusy(false);
      if (dry.status !== 200) {
        if (dry.json?.code === 'REFUSED_INVALID_BOOK') {
          return fail('Fix the problems first (Repair...). This book has errors in its manuscript files, so nothing is moved or renumbered for you.', true);
        }
        return fail(explainFailure(dry.status, dry.json));
      }
      const changes = dry.json?.changes ?? [];
      if (changes.length === 0) {
        showToast({ message: `"${name}" is already there.` });
        return { ok: true };
      }
      // what is applied is exactly what was previewed: the server refuses (CONFLICT) if any of these files changed since
      const expect = changes.filter((c) => c.from && c.before_sha256).map((c) => ({ path: c.from, sha256: c.before_sha256 }));
      const cmd = {
        url,
        body: { ...body, expect },
        done: done ?? `Moved "${name}".`,
        undoable: true, // Undo = restore of the operation (exact paths, numbers and bytes)
        after: () => onMoved?.(scene.id, target),
      };
      if (changes.length === 1 && changes[0].from === pathsOf(book, scene.path).bookRel) {
        // only the moved scene's own file changes: no neighbour is renumbered, so no Preview
        setBusy(true);
        const r = await applyNow(cmd);
        setBusy(false);
        return r.ok ? { ok: true } : fail(r.message);
      }
      setMoveDialog(null);
      setForm(null);
      setPreview({
        title: `Move "${name}"`,
        changes,
        notes: [{ heading: 'Neighbouring scenes are renumbered to make room. No scene text changes.', items: [] }],
        cmd,
      });
      return { ok: true };
    } finally {
      moving.current = false;
    }
  }

  async function undo() {
    const opId = toast?.opId;
    if (!opId) return;
    setToast(null);
    const { status, json } = await write(bookUrl(bookId, `/ops/${encodeURIComponent(opId)}/restore`), {});
    if (status === 200) {
      showToast({ message: 'Undone.' });
      onChanged?.(json);
    } else {
      showToast({ message: `Could not undo: ${explainFailure(status, json)}` });
    }
  }

  /** Start a command from a menu or button. */
  function start(c) {
    switch (c.type) {
      case 'rename-scene':
        setForm({
          title: 'Rename scene',
          submit: 'Rename',
          fields: [
            { name: 'title', label: 'Title', initial: c.scene.title ?? '' },
            { name: 'pov', label: 'POV (codex slug, optional)', initial: c.scene.pov ?? '' },
            { name: 'renameFile', label: 'Also rename the file', type: 'checkbox', hint: 'Moves the file to a name that matches the title (with a preview). The text is untouched.' },
          ],
          onSubmit: async (v) => {
            const body = { title: v.title, ...(v.pov && v.pov !== (c.scene.pov ?? '') ? { pov: v.pov } : {}), ...(v.renameFile ? { renameFile: true } : {}) };
            const cmd = { title: 'Rename scene', url: sceneUrl(c.scene.id, '/fields'), body, done: `Renamed to "${v.title}".`, undoable: true };
            if (v.renameFile) return previewThenApply(cmd, { stayInForm: true });
            const r = await applyNow(cmd);
            return r.ok ? { close: true } : { error: r.message };
          },
        });
        break;
      case 'status':
        applyNow({ url: sceneUrl(c.scene.id, '/fields'), body: { status: c.status }, done: `"${sceneName(c.scene)}" is now ${c.status}.`, undoable: true }).then((r) => {
          if (!r.ok) showToast({ message: `Not changed: ${r.message}` });
        });
        break;
      case 'add-scene':
        setForm({
          title: 'Add scene',
          submit: 'Preview',
          fields: [{ name: 'title', label: 'Scene title (optional)', initial: '' }],
          onSubmit: (v) =>
            previewThenApply(
              { title: 'Add scene', url: bookUrl(bookId, '/scenes'), body: { chapter: c.chapter, act: c.act, after: c.after, title: v.title.trim(), slug: slugify(v.title), body: '' }, done: 'Scene added.', after: toScene },
              { stayInForm: true },
            ),
        });
        break;
      case 'split': {
        const open = bridge.current();
        const splitCmd = (atLine) => ({ title: `Split "${sceneName(c.scene)}"`, url: sceneUrl(c.scene.id, '/split'), body: { atLine }, done: 'Scene split.', after: toScene });
        if (open && open.sceneId === c.scene.id && open.caretLine() !== null) {
          // the scene is open in the editor: split at the caret line, after saving what was typed
          (async () => {
            const { saved } = await open.flush();
            if (!saved) {
              showToast({ message: 'Not split: the scene has changes that could not be saved yet. Resolve that first.' });
              return;
            }
            await previewThenApply(splitCmd(open.caretLine()));
          })();
          break;
        }
        setForm({
          title: 'Split scene',
          submit: 'Preview',
          fields: [
            {
              name: 'atLine',
              label: 'Start the new scene at line',
              type: 'number',
              initial: '2',
              required: true,
              hint: 'A line of the scene text, counting from 1 (front matter does not count). Lines before it stay; this line and the rest become a new scene right after. Open the scene to split at the cursor instead.',
            },
          ],
          onSubmit: (v) => previewThenApply(splitCmd(Number(v.atLine)), { stayInForm: true }),
        });
        break;
      }
      case 'raw-file': {
        const open = bridge.current();
        (async () => {
          if (open && open.sceneId === c.scene.id) {
            const { saved } = await open.flush();
            if (!saved) {
              showToast({ message: 'Not opened: the scene has changes that could not be saved yet. Resolve that first.' });
              return;
            }
          }
          setRaw(c.scene);
        })();
        break;
      }
      case 'merge':
        previewThenApply({
          title: `Merge with "${sceneName(c.next)}"`,
          url: bookUrl(bookId, '/scenes/merge'),
          body: { first: c.scene.id, second: c.next.id },
          done: 'Scenes merged. The second scene is in Archived.',
        });
        break;
      case 'archive-scene': {
        const { scene } = c;
        localPreview(`Archive "${sceneName(scene)}"`, [{ from: scene.path, to: `archive/${pathsOf(book, scene.path).bookRel}` }], async () => {
          const got = await fetch(sceneUrl(scene.id), { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null), () => null);
          if (!got?.sha256) return { ok: false, message: 'The scene could not be read. Reload the page.' };
          const { status, json } = await write(sceneUrl(scene.id, '/archive'), { base_sha256: got.sha256 });
          if (status !== 200) return { ok: false, message: explainFailure(status, json) };
          showToast({ message: `Archived "${sceneName(scene)}".` });
          onChanged?.(json);
          if (scene.id === activeId) toBook();
          return { ok: true };
        });
        break;
      }
      case 'restore-scene': {
        const { bookRel, libRel } = pathsOf(book, c.entry.path);
        localPreview(`Restore ${c.name}`, [{ from: bookRel, to: bookRel.replace(/^archive\//, '') }], async () => {
          const raw = await fetch(bookUrl(bookId, `/raw?path=${encodeURIComponent(bookRel)}`), { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null), () => null);
          if (!raw?.sha256) return { ok: false, message: 'The archived file could not be read. Reload the page.' };
          const { status, json } = await write(bookUrl(bookId, '/archive/restore'), { path: libRel, base_sha256: raw.sha256 });
          if (status !== 200) return { ok: false, message: explainFailure(status, json) };
          showToast({ message: `Restored ${c.name}.` });
          onChanged?.(json);
          return { ok: true };
        });
        break;
      }
      case 'move':
        setMoveDialog({ scene: c.scene, error: null, repair: false });
        break;
      case 'tidy':
        (async () => {
          const plan = await fetch(bookUrl(bookId, '/repair/plan'), { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null), () => null);
          if (!plan?.ok) {
            showToast({ message: 'Could not check the file names. Try again.' });
            return;
          }
          const actions = plan.actions.filter((a) => a.kind === 'rename');
          if (actions.length === 0) {
            showToast({ message: 'File names are already tidy.' });
            return;
          }
          localPreview('Tidy file names', actions.map((a) => ({ from: a.from, to: a.to })), async () => {
            const { status, json } = await write(bookUrl(bookId, '/repair'), { actions });
            if (status !== 200) return { ok: false, message: explainFailure(status, json) };
            showToast({ message: `Tidied ${actions.length === 1 ? '1 file name' : `${actions.length} file names`}.` });
            onChanged?.(json);
            return { ok: true };
          });
        })();
        break;
      case 'rename-chapter':
        setForm({
          title: 'Rename chapter',
          submit: 'Preview',
          fields: [{ name: 'title', label: 'Chapter title', initial: c.chapter.title ?? '' }],
          onSubmit: (v) =>
            previewThenApply({ title: 'Rename chapter', url: bookUrl(bookId, `/chapters/${c.chapter.chapter}/fields`), body: { title: v.title }, done: 'Chapter renamed.' }, { stayInForm: true }),
        });
        break;
      case 'add-chapter':
        setForm({
          title: 'Add chapter',
          submit: 'Preview',
          fields: [{ name: 'title', label: 'Chapter title', initial: '', required: true }],
          onSubmit: (v) =>
            previewThenApply({
              title: 'Add chapter',
              url: bookUrl(bookId, '/chapters'),
              body: { act: c.act, ...(c.after !== undefined ? { after: c.after } : {}), title: v.title.trim() },
              done: 'Chapter added.',
              after: toScene,
            }),
        });
        break;
      case 'archive-chapter':
        previewThenApply({
          title: `Archive ${c.name}`,
          url: bookUrl(bookId, `/chapters/${c.chapter.chapter}/archive`),
          body: {},
          done: `Archived ${c.name}.`,
          undoable: true,
          after: () => {
            if (c.chapter.scenes.some((s) => s.id === activeId)) toBook();
          },
        });
        break;
      case 'renumber':
        previewThenApply({ title: 'Renumber chapters', url: bookUrl(bookId, '/chapters/renumber'), body: { step: 1 }, done: 'Chapters renumbered.', undoable: true });
        break;
      case 'new-act':
        setForm({
          title: 'New act',
          submit: 'Preview',
          fields: [{ name: 'title', label: 'Act title', initial: '', required: true }],
          onSubmit: (v) => previewThenApply({ title: 'New act', url: bookUrl(bookId, '/acts'), body: { title: v.title.trim() }, done: 'Act added.' }, { stayInForm: true }),
        });
        break;
      case 'rename-act':
        setForm({
          title: 'Rename act',
          submit: 'Preview',
          fields: [{ name: 'title', label: 'Act title', initial: c.act.title ?? '' }],
          onSubmit: (v) => previewThenApply({ title: 'Rename act', url: bookUrl(bookId, `/acts/${c.act.act}/fields`), body: { title: v.title }, done: 'Act renamed.' }, { stayInForm: true }),
        });
        break;
      default:
        break;
    }
  }

  const ui = (
    <>
      {form && <FormDialog key={form.title} form={form} busy={busy} onClose={() => setForm(null)} onSubmit={submitForm} />}
      {preview && <PreviewDialog preview={preview} busy={busy} onApply={apply} onCancel={() => setPreview(null)} />}
      {raw && (
        <RawEditorDialog
          book={book}
          scene={raw}
          onClose={() => setRaw(null)}
          onSaved={(info) => {
            showToast({ message: 'Raw file saved.' });
            onChanged?.(info);
          }}
        />
      )}
      {moveDialog && (
        <MoveDialog
          book={book}
          scene={moveDialog.scene}
          busy={busy}
          error={moveDialog.error}
          repair={moveDialog.repair}
          onRepair={() => {
            setMoveDialog(null);
            setRepairing(true);
          }}
          onClose={() => setMoveDialog(null)}
          onSubmit={async (target) => {
            const r = await move(moveDialog.scene, target, { fromDialog: true });
            if (r.ok) setMoveDialog(null);
            else setMoveDialog((d) => (d ? { ...d, error: r.error, repair: Boolean(r.repair) } : d));
          }}
        />
      )}
      {repairing && (
        <RepairDialog
          books={[{ book_id: book.id, title: book.title ?? null, path: book.path ?? '' }]}
          onClose={() => {
            setRepairing(false);
            onChanged?.();
          }}
        />
      )}
      {toast && <Toast toast={toast} onUndo={undo} onDismiss={() => setToast(null)} />}
    </>
  );
  return { start, ui, move, apply: applyNow, preview: previewThenApply, showToast };
}
