// The quiet toolbar of the chapter editor: bold, italic, heading, quote, list, scene note and the in-scene break (`***`). It shows while the text has focus or a selection,
// and stays when the author pins it with "Formatting". Buttons keep the editor's selection (mousedown is prevented). Keyboard: Mod-b, Mod-i (schema.js).
import { useEditorState } from '@tiptap/react';
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';

/** Make a note's text safe for `<!-- note: ... -->`: one line, and no comment end. @param {string} text */
export const cleanNoteText = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/-->/g, '-- >').trim();

function NoteDialog({ onInsert, onClose }) {
  const [text, setText] = useState('');
  const clean = cleanNoteText(text);
  return (
    <Dialog label="Scene note" onClose={onClose}>
      <h2>Scene note</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (clean !== '') onInsert(clean);
        }}
      >
        <div className="form-row">
          <label>
            <span className="form-label">Note to yourself (not part of the prose)</span>
            <textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} autoFocus />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={clean === ''}>
            Add note
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Tool({ label, shortcut, active = false, disabled = false, onRun, children }) {
  return (
    <button
      type="button"
      className="sf-tool"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

/** @param {{ editor: import('@tiptap/core').Editor | null, disabled?: boolean }} props */
export function ChapterToolbar({ editor, disabled = false }) {
  const [pinned, setPinned] = useState(false);
  const [noting, setNoting] = useState(false);
  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed
        ? {
            focused: ed.isFocused,
            selection: !ed.state.selection.empty,
            bold: ed.isActive('bold'),
            italic: ed.isActive('italic'),
            heading: ed.isActive('heading'),
            quote: ed.isActive('blockquote'),
            bullets: ed.isActive('bulletList'),
            numbers: ed.isActive('orderedList'),
          }
        : null,
  });
  if (!editor || !s) return null;
  const run = (fn) => () => {
    fn(editor.chain().focus());
  };
  const visible = pinned || s.focused || s.selection;
  return (
    <div className="sf-toolbar-wrap">
      <div className="sf-toolbar" role="toolbar" aria-label="Formatting" data-visible={visible ? 'true' : 'false'}>
        <Tool label="Bold" shortcut="Ctrl+B" active={s.bold} disabled={disabled} onRun={run((c) => c.toggleMark('bold').run())}>
          <strong>B</strong>
        </Tool>
        <Tool label="Italic" shortcut="Ctrl+I" active={s.italic} disabled={disabled} onRun={run((c) => c.toggleMark('italic').run())}>
          <em>I</em>
        </Tool>
        <Tool label="Heading" active={s.heading} disabled={disabled} onRun={run((c) => c.toggleHeadingLevel(2).run())}>
          H
        </Tool>
        <Tool label="Quote" active={s.quote} disabled={disabled} onRun={run((c) => c.toggleQuote().run())}>
          &ldquo;
        </Tool>
        <Tool label="Bulleted list" active={s.bullets} disabled={disabled} onRun={run((c) => c.toggleBullets().run())}>
          &bull;
        </Tool>
        <Tool label="Numbered list" active={s.numbers} disabled={disabled} onRun={run((c) => c.toggleNumbers().run())}>
          1.
        </Tool>
        <Tool label="Scene note" disabled={disabled} onRun={() => setNoting(true)}>
          Note
        </Tool>
        <Tool label="Break inside the scene" disabled={disabled} onRun={run((c) => c.insertInSceneBreak().run())}>
          * * *
        </Tool>
      </div>
      <button type="button" className="sf-toolbar-toggle" aria-pressed={pinned} onClick={() => setPinned((p) => !p)}>
        Formatting
      </button>
      {noting && (
        <NoteDialog
          onClose={() => setNoting(false)}
          onInsert={(text) => {
            setNoting(false);
            editor.chain().focus().insertAuthorNote(text).run();
          }}
        />
      )}
    </div>
  );
}
