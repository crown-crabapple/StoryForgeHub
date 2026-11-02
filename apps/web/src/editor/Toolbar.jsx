// The formatting toolbar above the text. Real buttons with names; the toggle exposes aria-pressed.
// Buttons keep focus out of the way: mousedown is prevented so the editor's selection is not lost.
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
 *   showMarks: boolean, onToggleMarks: () => void, disabled?: boolean }} props
 */
export function EditorToolbar({ onBold, onItalic, onLink, onNote, onSceneBreak, showMarks, onToggleMarks, disabled = false }) {
  const mod = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '') ? 'Cmd' : 'Ctrl';
  return (
    <div role="toolbar" aria-label="Formatting" className="editor-toolbar">
      <ToolButton name="bold" label="Bold" shortcut={`${mod}+B`} onRun={onBold} disabled={disabled} />
      <ToolButton name="italic" label="Italic" shortcut={`${mod}+I`} onRun={onItalic} disabled={disabled} />
      <ToolButton name="link" label="Link to Codex or thread" shortcut={`${mod}+K`} onRun={onLink} disabled={disabled} />
      <ToolButton name="note" label="Author note" shortcut={`${mod}+Alt+M`} onRun={onNote} disabled={disabled} />
      <ToolButton name="scene-break" label="Scene break" shortcut={`${mod}+Enter`} onRun={onSceneBreak} disabled={disabled} />
      <span className="editor-toolbar-sep" aria-hidden="true" />
      <button type="button" className="editor-tool editor-tool-text" aria-pressed={showMarks} onMouseDown={(e) => e.preventDefault()} onClick={onToggleMarks}>
        Show Markdown marks
      </button>
    </div>
  );
}
