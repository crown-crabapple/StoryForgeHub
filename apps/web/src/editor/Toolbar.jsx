// The formatting toolbar above the text. Real buttons with names; the toggle exposes aria-pressed.
// Buttons keep focus out of the way: mousedown is prevented so the editor's selection is not lost.
import { useShortcuts } from '../shortcuts/ShortcutsContext.jsx';

const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' };

const PATHS = {
  bold: 'M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9M14 20H5M15 4 9 20',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  note: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'scene-break': 'M5 12h.01M12 12h.01M19 12h.01',
};

function ToolButton({ name, label, shortcut, onRun, disabled }) {
  return (
    <button
      type="button"
      className="editor-tool"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      <svg {...icon}>
        <path d={PATHS[name]} />
      </svg>
    </button>
  );
}

/**
 * @param {{ onBold: () => void, onItalic: () => void, onLink: () => void, onNote: () => void, onSceneBreak: () => void,
 *   showMarks: boolean, onToggleMarks: () => void, onFocus?: () => void, onCheck?: () => void, onRewrite?: () => void, onWorkshop?: () => void, onPrompts?: () => void, disabled?: boolean }} props  `onFocus` shows the "Focus" button;
 *   `onCheck` shows "Check scene" (a local, read-only report, M05-J06); `onRewrite` / `onWorkshop` show "Rewrite with AI..." and "AI workshop" (only when the book has an active AI provider).
 */
export function EditorToolbar({ onBold, onItalic, onLink, onNote, onSceneBreak, showMarks, onToggleMarks, onFocus, onCheck, onRewrite, onWorkshop, onPrompts, disabled = false }) {
  const keys = useShortcuts(); // the live bindings from the shortcut registry (M07-J04): a rebound command shows its new chord
  return (
    <div role="toolbar" aria-label="Formatting" className="editor-toolbar">
      <ToolButton name="bold" label="Bold" shortcut={keys.display('editor.bold')} onRun={onBold} disabled={disabled} />
      <ToolButton name="italic" label="Italic" shortcut={keys.display('editor.italic')} onRun={onItalic} disabled={disabled} />
      <ToolButton name="link" label="Link to Codex or thread" shortcut={keys.display('editor.link')} onRun={onLink} disabled={disabled} />
      <ToolButton name="note" label="Author note" shortcut={keys.display('editor.note')} onRun={onNote} disabled={disabled} />
      <ToolButton name="scene-break" label="Scene break" shortcut={keys.display('editor.sceneBreak')} onRun={onSceneBreak} disabled={disabled} />
      <span className="editor-toolbar-sep" aria-hidden="true" />
      <button type="button" className="editor-tool editor-tool-text" aria-pressed={showMarks} onMouseDown={(e) => e.preventDefault()} onClick={onToggleMarks}>
        Show Markdown marks
      </button>
      {onCheck && (
        <button type="button" className="editor-tool editor-tool-text" onMouseDown={(e) => e.preventDefault()} onClick={onCheck}>
          Check scene
        </button>
      )}
      {onRewrite && (
        <button type="button" className="editor-tool editor-tool-text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onRewrite}>
          Rewrite with AI…
        </button>
      )}
      {onWorkshop && (
        <button type="button" className="editor-tool editor-tool-text" onMouseDown={(e) => e.preventDefault()} onClick={onWorkshop}>
          AI workshop
        </button>
      )}
      {onPrompts && (
        <button type="button" className="editor-tool editor-tool-text" onMouseDown={(e) => e.preventDefault()} onClick={onPrompts}>
          Run a prompt…
        </button>
      )}
      {onFocus && (
        <button type="button" className="editor-tool editor-tool-text" title={`Focus mode (${keys.display('focus.toggle')})`} aria-keyshortcuts={keys.aria('focus.toggle')} onMouseDown={(e) => e.preventDefault()} onClick={onFocus}>
          Focus
        </button>
      )}
    </div>
  );
}
