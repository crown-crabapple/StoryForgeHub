import { useEffect, useRef, useState } from 'react';
import { useEditorBridge } from '../editor/bridge.jsx';
import { RawEditorDialog } from '../editor/RawEditor.jsx';
import { useNavigate } from '../router.jsx';
import { RepairDialog } from '../RepairDialog.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { ToastFrame } from '../shell/ToastStack.jsx';
import { useWrites } from '../shell/writes.jsx';
import { MoveDialog } from './MoveDialog.jsx';
import { chapterPlaces, currentChapterPlace, parseChapterPlace } from './move-target.js';
import { PreviewDialog } from './PreviewDialog.jsx';
import { bookUrl, explainFailure, pathsOf, send, slugify } from './helpers.js';

const TOAST_MS = 12000;

/**
 * One small form in a dialog. `fields`: [{ name, label, type?: 'text' | 'number' | 'checkbox' | 'select', initial?, hint?, required?, groups? }].
 * A select takes `groups`: [{ label, options: [{ value, label }] }] (one optgroup each).
 */
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
              ) : f.type === 'select' ? (
                <select name={f.name} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                  {(f.groups ?? []).map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
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
    <ToastFrame>
      <span>{toast.message}</span>
      {toast.opId && (
        <button type="button" className="btn toast-button" onClick={onUndo}>
          Undo
        </button>
      )}
      <button type="button" className="btn toast-button" onClick={onDismiss}>
        Dismiss
      </button>
    </ToastFrame>
  );
}

const sceneName = (s) => s.title || 'Untitled scene';

/**
 * The structure commands of the manuscript tree: forms, applying, the problem dialog, and the Undo toast.
 * Returns `start(command)` and `ui` (the dialogs and the toast, rendered once next to the tree).
 * Every write applies at once (no Preview step) and the toast offers Undo where the operation can be restored; a refusal opens a
 * dialog with the reason.
 * `move(scene, target)` (drag and drop, Alt+Up/Down, the Move... dialog) flushes the open editor, asks the server for a dry run, and
 * applies at once, also when neighbours are renumbered (toast with Undo = restore of the operation). `onMoved(sceneId, target)` runs after a move was written.
 * `apply(cmd)` and `preview(cmd, { stayInForm })` are the same two paths for any other write command `{ title, url, body, done, undoable?, after? }` (the
 * Board, Outline and Threads views use them): both write at once and offer Undo (`preview` is the older name, kept for callers).
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
   * Write a command at once (no Preview step): the toast says what was done and offers Undo when the command is undoable. A refusal
   * opens the problem dialog with the reason (a "no gap" refusal offers Renumber), or, with `stayInForm`, is returned so the form can
   * show it and stay editable. The server still checks every write (validation, conflicts), so nothing invalid is applied.
   */
  async function previewThenApply(cmd, { stayInForm = false } = {}) {
    setBusy(true);
    const { status, json } = await write(cmd.url, cmd.body);
    setBusy(false);
    if (status !== 200 && status !== 201) {
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
    const skipped = json?.not_merged?.length ? ` Not merged (copy them by hand if you want them): ${json.not_merged.map((n) => n.text).join('; ')}.` : '';
    showToast({ message: `${cmd.done}${skipped}`, opId: cmd.undoable ? (json?.opId ?? null) : null });
    onChanged?.(json);
    cmd.after?.(json);
    return stayInForm ? { close: true } : undefined;
  }
  const startRef = useRef(null);
  useEffect(() => {
    startRef.current = start;
  });

  /** A command run in the browser (archive and restore of one scene, tidy file names): runs at once; a failure opens the problem dialog. */
  const localPreview = async (title, _changes, run) => {
    setBusy(true);
    const r = await run();
    setBusy(false);
    if (!r.ok) setPreview({ title, error: r.message, changes: [] });
  };

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
      // applied at once, also when neighbours are renumbered to make room (Undo restores every file exactly)
      setBusy(true);
      const r = await applyNow(cmd);
      setBusy(false);
      return r.ok ? { ok: true } : fail(r.message);
    } finally {
      moving.current = false;
    }
  }

  /**
   * Move a whole chapter (drag and drop, Move to act...): flushes the open editor, then applies at once (Undo restores every file of the
   * chapter and any renumbered chapter). `target`: { act, after } as POST .../chapters/:n/move takes it.
   * @returns {Promise<{ error?: string } | undefined>}
   */
  async function moveChapter(chapterNode, target, { stayInForm = false } = {}) {
    const name = chapterNode.title ? `${chapterNode.label}: ${chapterNode.title}` : chapterNode.label;
    const open = bridge.current();
    if (open) {
      const blocked = (message) => {
        if (stayInForm) return { error: message };
        showToast({ message });
        return undefined;
      };
      if (open.isConflict?.()) return blocked('Not moved: the open scene has a conflict with the file on disk. Resolve that first.');
      const { saved } = await open.flush();
      if (!saved) return blocked('Not moved: the open scene has changes that could not be saved yet. Resolve that first.');
    }
    return previewThenApply(
      {
        title: `Move ${name}`,
        url: bookUrl(bookId, `/chapters/${chapterNode.chapter}/move`),
        body: { act: target.act, ...(target.after !== undefined ? { after: target.after } : {}) },
        done: `Moved ${name}.`,
        undoable: true,
      },
      { stayInForm },
    );
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
            { name: 'renameFile', label: 'Also rename the file', type: 'checkbox', hint: 'Moves the file to a name that matches the title. The text is untouched.' },
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
          submit: 'Add',
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
          submit: 'Split',
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
          undoable: true,
        });
        break;
      case 'archive-scene': {
        const { scene } = c;
        localPreview(`Archive "${sceneName(scene)}"`, [{ from: scene.path, to: `archive/${pathsOf(book, scene.path).bookRel}` }], async () => {
          const got = await fetch(sceneUrl(scene.id), { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null), () => null);
          if (!got?.sha256) return { ok: false, message: 'The scene could not be read. Reload the page.' };
          const { status, json } = await write(sceneUrl(scene.id, '/archive'), { base_sha256: got.sha256 });
          if (status !== 200) return { ok: false, message: explainFailure(status, json) };
          showToast({ message: `Archived "${sceneName(scene)}".`, opId: json?.opId ?? null });
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
          submit: 'Rename',
          fields: [{ name: 'title', label: 'Chapter title', initial: c.chapter.title ?? '' }],
          onSubmit: (v) =>
            previewThenApply({ title: 'Rename chapter', url: bookUrl(bookId, `/chapters/${c.chapter.chapter}/fields`), body: { title: v.title }, done: 'Chapter renamed.', undoable: true }, { stayInForm: true }),
        });
        break;
      case 'add-chapter':
        setForm({
          title: 'Add chapter',
          submit: 'Add',
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
      case 'move-chapter': {
        const initial = currentChapterPlace(book, c.chapter.chapter);
        setForm({
          title: `Move ${c.name} to act`,
          submit: 'Move',
          fields: [{ name: 'place', label: 'Where', type: 'select', initial, groups: chapterPlaces(book, c.chapter.chapter), hint: 'Chapters are numbered in book order, so other chapters may be renumbered. Undo puts every file back.' }],
          onSubmit: (v) => {
            const place = parseChapterPlace(v.place);
            if (!place) return { error: 'Choose where the chapter goes.' };
            if (v.place === initial) return { close: true };
            return moveChapter(c.chapter, place, { stayInForm: true });
          },
        });
        break;
      }
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
      case 'renumber': {
        const nums = (book?.acts ?? []).flatMap((a) => a.chapters.map((ch) => ch.chapter));
        const initial = nums.length && Math.min(...nums) === 0 ? '0' : '1';
        setForm({
          title: 'Renumber chapters',
          submit: 'Renumber',
          fields: [
            {
              name: 'start',
              label: 'Number the first chapter',
              type: 'select',
              initial,
              groups: [{ label: 'First chapter', options: [{ value: '1', label: 'Chapter 1' }, { value: '0', label: 'Chapter 0 (a prologue)' }] }],
              hint: 'Every chapter is numbered in book order with no gaps (1, 2, 3...). Folders follow; no text changes. Undo puts every file back.',
            },
          ],
          onSubmit: (v) =>
            previewThenApply(
              { title: 'Renumber chapters', url: bookUrl(bookId, '/chapters/renumber'), body: { step: 1, start: Number(v.start) }, done: 'Chapters renumbered.', undoable: true },
              { stayInForm: true },
            ),
        });
        break;
      }
      case 'new-act':
        setForm({
          title: 'New act',
          submit: 'Add',
          fields: [{ name: 'title', label: 'Act title', initial: '', required: true }],
          onSubmit: (v) => previewThenApply({ title: 'New act', url: bookUrl(bookId, '/acts'), body: { title: v.title.trim() }, done: 'Act added.' }, { stayInForm: true }),
        });
        break;
      case 'rename-act':
        setForm({
          title: 'Rename act',
          submit: 'Rename',
          fields: [{ name: 'title', label: 'Act title', initial: c.act.title ?? '' }],
          onSubmit: (v) => previewThenApply({ title: 'Rename act', url: bookUrl(bookId, `/acts/${c.act.act}/fields`), body: { title: v.title }, done: 'Act renamed.', undoable: true }, { stayInForm: true }),
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
  return { start, ui, move, moveChapter, apply: applyNow, preview: previewThenApply, showToast };
}
