// The scene break as the author sees it: the scene's title (click to rename), a small save-state chip, a link to the Source editor, the notes toggle, and under them
// whatever needs attention for that scene (read-only reason, a save that cannot be written, a draft found, offline, conflict). A React node view over the `sceneBreak` node.
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ConflictPanel } from '../editor/ConflictPanel.jsx';
import { StalePanel } from '../editor/StalePanel.jsx';
import { RESTORED_NOTICE } from '../editor/offline-queue.js';
import { Link } from '../router.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { useChapter } from './ChapterContext.js';
import { chipLabel } from './chapter-state.js';
import { NotesMargin } from './NotesMargin.jsx';
import { chapterExtensions, SceneBreak } from './schema.js';

const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const READ_ONLY_TEXT = {
  mixed: 'This scene mixes line endings, so it is shown read-only here. Open the source to normalise them.',
  raw: 'This file is shown as it is on disk. It is not edited here.',
  failed: 'This scene could not be loaded. Reload the page to try again.',
};

function TitleEditor({ title, onCommit, onCancel }) {
  const [value, setValue] = useState(title);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="sf-break-input"
      aria-label="Scene title"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value.trim())}
    />
  );
}

/** @param {import('@tiptap/react').NodeViewProps} props */
export function SceneBreakView({ node }) {
  const ctx = useChapter();
  const { sceneId, readOnly, reason } = node.attrs;
  const [renaming, setRenaming] = useState(false);
  const [dialog, setDialog] = useState(/** @type {'keep-mine' | null} */ (null));
  const [copied, setCopied] = useState(/** @type {string | null} */ (null));
  if (!ctx) {
    return (
      <NodeViewWrapper className="sf-break">
        <h2 className="sf-break-title">{node.attrs.title || 'Untitled scene'}</h2>
      </NodeViewWrapper>
    );
  }
  const { actions } = ctx;
  const info = ctx.scenes[sceneId] ?? { title: node.attrs.title, summary: '', sourceHref: '#', problem: null };
  const title = info.title || 'Untitled scene';
  const snap = ctx.snaps[sceneId];
  const state = snap?.state;
  const label = chipLabel(state);
  const open = ctx.notesOpen[sceneId] === true;
  const noteCount = ctx.notes[sceneId]?.length ?? 0;
  const error = ctx.errors[sceneId];
  const notice = ctx.notices[sceneId];
  const offer = ctx.offers[sceneId];

  const commitTitle = (next) => {
    setRenaming(false);
    if (next !== '' && next !== info.title) void actions.renameScene(sceneId, next);
  };

  return (
    <NodeViewWrapper className="sf-break" data-scene-id={sceneId} data-read-only={readOnly ? 'true' : undefined}>
      <div className="sf-break-row">
        {renaming ? (
          <TitleEditor title={info.title} onCommit={commitTitle} onCancel={() => setRenaming(false)} />
        ) : ctx.canEdit && !readOnly ? (
          <h2 className="sf-break-title">
            <button type="button" className="sf-break-name" title="Rename this scene" aria-label={`Scene title: ${title}. Rename`} onClick={() => setRenaming(true)}>
              {title}
            </button>
          </h2>
        ) : (
          <h2 className="sf-break-title">{title}</h2>
        )}
        {label && (
          <span className="sf-chip" data-state={state} role="status" aria-label={`${title}: ${label}`}>
            {label}
          </span>
        )}
        <span className="sf-break-tools">
          <button type="button" className="sf-break-link" aria-expanded={open} aria-controls={`sf-margin-${sceneId}`} onClick={() => actions.toggleNotes(sceneId)}>
            Notes{noteCount > 0 ? ` (${noteCount})` : ''}
          </button>
          <Link to={info.sourceHref} className="sf-break-link">
            {readOnly ? 'Open source' : 'Source'}
          </Link>
        </span>
      </div>

      {readOnly && (
        <p className="sf-break-note" role="note">
          {reason === 'problem'
            ? `This file can't be read (${info.problem?.code ?? 'unknown'}: ${info.problem?.message ?? 'no detail'}). Its text is shown exactly as it is on disk; fix it in your editor.`
            : (READ_ONLY_TEXT[reason] ?? READ_ONLY_TEXT.raw)}
        </p>
      )}
      {error && (
        <section className="editor-notice editor-notice-danger" role="alert">
          <p>{error}</p>
        </section>
      )}
      {notice && (
        <p className="editor-flash" role="status">
          {notice}{' '}
          {copied && (
            <>
              <Link to={`/books/${encodeURIComponent(ctx.bookId)}?scene=${encodeURIComponent(copied)}`}>Open it</Link>{' '}
            </>
          )}
          <button type="button" className="btn row-button" onClick={() => actions.dismissNotice(sceneId)}>
            Dismiss
          </button>
        </p>
      )}
      {ctx.queued[sceneId] && state !== 'saved' && state !== 'clean' && state !== 'conflict' && (
        <p className="editor-offline editor-queued" role="status">
          {RESTORED_NOTICE}
        </p>
      )}
      {offer && state !== 'conflict' && (
        <section className="editor-notice" role="region" aria-label={`Unsaved changes found in ${title}`}>
          <p>You have unsaved changes in this scene from {formatTime(offer.at)}.</p>
          <div className="editor-notice-actions">
            <button type="button" className="btn btn-primary" onClick={() => actions.restoreOffer(sceneId)}>
              Restore
            </button>
            <button type="button" className="btn" onClick={() => actions.discardOffer(sceneId)}>
              Discard
            </button>
          </div>
        </section>
      )}
      {state === 'conflict' && snap && snap.conflict?.stale && (
        <StalePanel snapshot={snap} title={title} canReview={ctx.canDecide && Boolean(snap.conflict.suggestionId)} onReview={() => actions.review(sceneId)} onUseCurrent={() => actions.useTheirs(sceneId)} />
      )}
      {state === 'conflict' && snap && !snap.conflict?.stale && (
        <ConflictPanel
          snapshot={snap}
          title={title}
          onCheckDisk={() => actions.checkDisk(sceneId)}
          onKeepMine={() => setDialog('keep-mine')}
          onUseFile={() => actions.useFile(sceneId)}
          onSaveCopy={async () => {
            const r = await actions.saveCopy(sceneId);
            if (r.ok && typeof r.id === 'string') setCopied(r.id);
            return r;
          }}
        />
      )}
      {state === 'error' && snap?.error && (
        <section className="editor-notice editor-notice-danger" role="alert">
          <p>
            <strong>This scene could not be saved</strong> (the server answered {snap.error.status}). Your text is kept here and in this browser.
          </p>
          <button type="button" className="btn" onClick={() => actions.retry(sceneId)}>
            Try again
          </button>
        </section>
      )}
      {state === 'offline' && (
        <p className="editor-offline" role="status">
          Can't reach StoryForge — retrying. Keep writing; your text is kept in this browser.{' '}
          <button type="button" className="btn row-button" onClick={() => actions.retry(sceneId)}>
            Retry now
          </button>
        </p>
      )}
      {open && <NotesMargin sceneId={sceneId} />}
      {dialog === 'keep-mine' && (
        <Dialog label="Keep your version?" onClose={() => setDialog(null)}>
          <h2>Keep your version?</h2>
          <p>This replaces the version on disk with the text in the editor.</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setDialog(null);
                void actions.keepMine(sceneId);
              }}
            >
              Overwrite the file
            </button>
          </div>
        </Dialog>
      )}
    </NodeViewWrapper>
  );
}

/** The scene break with its React view. */
export const SceneBreakWithView = SceneBreak.extend({
  addNodeView() {
    return ReactNodeViewRenderer(SceneBreakView);
  },
});

/** The extensions of the chapter editor: schema v1, with the scene break drawn by SceneBreakView. */
export const chapterEditorExtensions = chapterExtensions.map((e) => (e === SceneBreak ? SceneBreakWithView : e));
