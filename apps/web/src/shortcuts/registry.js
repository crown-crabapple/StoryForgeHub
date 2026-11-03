// The shortcut registry (M07-J04 contract section 4): every command with a keyboard binding, in one list. The editor commands, focus mode, moving scenes and the
// dialogs all take their keys from here; Settings > Shortcuts rebinds them; the cheat sheet lists them. Pure: no DOM, no React.
//
// A chord is written `Mod+Alt+Shift+Key`: `Mod` is Ctrl (Cmd on a Mac), the key is a letter in capitals, a digit, a symbol, or a name like Enter, ArrowUp or F5.

/**
 * @typedef {{ id: string, label: string, scope: 'global' | 'editor' | 'outline' | 'board' | 'timeline' | 'dialog', binding: string | null, fixed?: boolean, files: string[] }} Command
 *   `files`: the source files (relative to src/) that carry the command out; a test checks every file that handles keys is named by a command or listed in WIDGET_KEYS.
 */

/** @type {Command[]} */
export const COMMANDS = [
  { id: 'editor.bold', label: 'Bold', scope: 'editor', binding: 'Mod+B', files: ['editor/SceneEditorPage.jsx', 'editor/Toolbar.jsx'] },
  { id: 'editor.italic', label: 'Italic', scope: 'editor', binding: 'Mod+I', files: ['editor/SceneEditorPage.jsx', 'editor/Toolbar.jsx'] },
  { id: 'editor.link', label: 'Link to Codex or thread', scope: 'editor', binding: 'Mod+K', files: ['editor/SceneEditorPage.jsx', 'editor/Toolbar.jsx'] },
  { id: 'editor.note', label: 'Author note', scope: 'editor', binding: 'Mod+Alt+M', files: ['editor/SceneEditorPage.jsx', 'editor/Toolbar.jsx'] },
  { id: 'editor.sceneBreak', label: 'Scene break', scope: 'editor', binding: 'Mod+Enter', files: ['editor/SceneEditorPage.jsx', 'editor/Toolbar.jsx'] },
  { id: 'editor.save', label: 'Save now', scope: 'editor', binding: 'Mod+S', files: ['editor/SceneEditorPage.jsx', 'editor/RawEditor.jsx'] },
  { id: 'focus.toggle', label: 'Focus mode on or off', scope: 'global', binding: 'Mod+Shift+F', files: ['writing/focus.js', 'writing/FocusContext.jsx', 'editor/Toolbar.jsx'] },
  { id: 'focus.exit', label: 'Leave focus mode', scope: 'global', binding: 'Escape', fixed: true, files: ['writing/focus.js', 'writing/FocusContext.jsx'] },
  { id: 'help.shortcuts', label: 'Show keyboard shortcuts', scope: 'global', binding: '?', files: ['shortcuts/ShortcutsContext.jsx'] },
  { id: 'outline.moveUp', label: 'Move the scene up one place', scope: 'outline', binding: 'Alt+ArrowUp', files: ['Outline.jsx'] },
  { id: 'outline.moveDown', label: 'Move the scene down one place', scope: 'outline', binding: 'Alt+ArrowDown', files: ['Outline.jsx'] },
  { id: 'board.moveUp', label: 'Move the card up one place', scope: 'board', binding: 'Alt+ArrowUp', files: ['planning/BoardView.jsx'] },
  { id: 'board.moveDown', label: 'Move the card down one place', scope: 'board', binding: 'Alt+ArrowDown', files: ['planning/BoardView.jsx'] },
  { id: 'board.chapterBack', label: 'Move the card to the previous chapter', scope: 'board', binding: 'Alt+ArrowLeft', files: ['planning/BoardView.jsx'] },
  { id: 'board.chapterForward', label: 'Move the card to the next chapter', scope: 'board', binding: 'Alt+ArrowRight', files: ['planning/BoardView.jsx'] },
  { id: 'timeline.moveUp', label: 'Move the event earlier', scope: 'timeline', binding: 'Alt+ArrowUp', files: ['timeline/TimelinePage.jsx'] },
  { id: 'timeline.moveDown', label: 'Move the event later', scope: 'timeline', binding: 'Alt+ArrowDown', files: ['timeline/TimelinePage.jsx'] },
  { id: 'dialog.close', label: 'Close the dialog', scope: 'dialog', binding: 'Escape', fixed: true, files: ['shell/Dialog.jsx'] },
  { id: 'dialog.trap', label: "Move between the dialog's controls (Tab stays inside)", scope: 'dialog', binding: 'Tab', fixed: true, files: ['shell/Dialog.jsx'] },
];

/**
 * Key handling that is part of a component and is not a command: moving inside a list, a menu, a grid or a field. These keys are fixed (they are how the widget works)
 * and are listed in the cheat sheet. A source file that reads keys must be named here or by a command, or the registry test fails.
 * @type {{ file: string, keys: string, what: string }[]}
 */
export const WIDGET_KEYS = [
  { file: 'Outline.jsx', keys: 'Arrow Up, Arrow Down', what: 'move between scenes in the chapter list' },
  { file: 'SearchBox.jsx', keys: 'Escape', what: 'close the search results' },
  { file: 'shell/BookSwitcher.jsx', keys: 'Arrow keys, Enter, Escape, letters', what: 'pick a book (type the first letter to jump)' },
  { file: 'structure/RowMenu.jsx', keys: 'Arrow Up, Arrow Down, Escape, Tab', what: 'the row menu of a scene or chapter' },
  { file: 'editor/LinkPicker.jsx', keys: 'Enter', what: 'choose the first match in the link picker' },
  { file: 'codex/CodexPage.jsx', keys: 'Arrow keys', what: 'move between Codex cards' },
  { file: 'continuity/ContinuityPage.jsx', keys: 'Arrow Up, Arrow Down, Home, End', what: 'move between continuity findings' },
  { file: 'planning/MatrixView.jsx', keys: 'Arrow Up, Arrow Down, Escape', what: 'move inside the thread matrix menu' },
  { file: 'planning/OutlineView.jsx', keys: 'Enter, Escape', what: 'save or cancel the one-line summary you are editing in the Outline view' },
  { file: 'timeline/TimelinePage.jsx', keys: 'Enter, Space', what: 'select an event card' },
  { file: 'prefs/PanelSeparator.jsx', keys: 'Arrow Left, Arrow Right, Home, End', what: 'resize a side panel (role=separator)' },
  { file: 'prefs/ShortcutSettings.jsx', keys: 'any chord', what: 'capture a key chord to rebind a command' },
  { file: 'insights/charts.jsx', keys: 'Arrow keys, Home, End', what: 'move between the cells of an Insights heat map' },
  { file: 'tasks/TasksPage.jsx', keys: 'Arrow Up, Arrow Down, Home, End', what: 'move between tasks in the list' },
  { file: 'shared/UserMenu.jsx', keys: 'Escape', what: 'close the account menu' },
];

/** Chords nothing may be bound to (browser and OS ones, and the keys the keyboard walk needs). Same list as @storyforge/format RESERVED_CHORDS (a test compares them). */
export const RESERVED_CHORDS = ['Mod+W', 'Mod+T', 'Mod+N', 'Mod+L', 'Mod+Tab', 'F5', 'Alt+F4', 'Tab', 'Shift+Tab', 'Escape'];

const MODIFIER_ORDER = ['Mod', 'Alt', 'Shift'];
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', ' ': 'Space', spacebar: 'Space', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
/** Symbols typed with Shift held: the key already says so, so a chord for them carries no Shift. Same as @storyforge/format SHIFTED_SYMBOLS. */
export const SHIFTED_SYMBOLS = '?:"<>{}|~!@#$%^&*()_+';

/**
 * One spelling for a chord (see the header). Null when it is not a chord. Same rules as @storyforge/format normalizeChord (a test compares them).
 * @param {unknown} chord @returns {string | null}
 */
export function normalizeChord(chord) {
  if (typeof chord !== 'string' || chord.trim() === '') return null;
  const parts = chord.trim() === '+' ? ['+'] : chord.trim().split(/\+(?=.)/);
  const key = parts.pop() ?? '';
  const mods = new Set();
  for (const p of parts) {
    const m = { ctrl: 'Mod', control: 'Mod', cmd: 'Mod', meta: 'Mod', command: 'Mod', mod: 'Mod', alt: 'Alt', option: 'Alt', shift: 'Shift' }[p.toLowerCase()];
    if (!m) return null;
    mods.add(m);
  }
  let name = KEY_ALIASES[key.toLowerCase()] ?? (/^f[0-9]{1,2}$/i.test(key) ? key.toUpperCase() : key);
  if (name.length === 1) name = name.toUpperCase();
  else if (!/^(F([1-9]|1[0-2])|[A-Z][A-Za-z]+)$/.test(name)) return null;
  if (name.length === 1 && SHIFTED_SYMBOLS.includes(name)) mods.delete('Shift');
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), name].join('+');
}

/** @param {unknown} chord */
export const isReserved = (chord) => {
  const n = normalizeChord(chord);
  return n !== null && RESERVED_CHORDS.includes(n);
};

/**
 * The chord a key event is, in the registry's spelling (Ctrl and Cmd both read as Mod). Null for a bare modifier key press.
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean }} e
 */
export function chordFromEvent(e) {
  if (typeof e.key !== 'string' || ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'OS', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Mod');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return normalizeChord([...mods, e.key].join('+'));
}

/** Is this key event the chord? @param {Parameters<typeof chordFromEvent>[0]} e @param {string | null | undefined} chord */
export function matchesChord(e, chord) {
  const want = normalizeChord(chord);
  return want !== null && chordFromEvent(e) === want;
}

/** The command table by id. */
export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/**
 * The binding of every command: its default, replaced by what the profile says (a chord, or null for "removed"). Fixed commands keep theirs.
 * @param {Record<string, string | null> | null | undefined} overrides @returns {Record<string, string | null>}
 */
export function bindingsFor(overrides) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const c of COMMANDS) {
    const o = overrides && Object.hasOwn(overrides, c.id) && !c.fixed ? overrides[c.id] : undefined;
    out[c.id] = o === undefined ? c.binding : o === null ? null : (normalizeChord(o) ?? c.binding);
  }
  return out;
}

/**
 * May `chord` be bound to `id`? Refused when it is reserved, not a chord, or another command in the same scope has it (both names are in the message).
 * @param {string} id @param {string | null} chord @param {Record<string, string | null>} bindings the current bindings
 * @returns {{ ok: true } | { ok: false, code: 'UNKNOWN_COMMAND' | 'FIXED' | 'BAD_CHORD' | 'RESERVED' | 'CONFLICT', message: string, with?: string[] }}
 */
export function validateBinding(id, chord, bindings) {
  const command = COMMAND_BY_ID.get(id);
  if (!command) return { ok: false, code: 'UNKNOWN_COMMAND', message: `${id} is not a command` };
  if (command.fixed) return { ok: false, code: 'FIXED', message: `${command.label} always uses ${command.binding}` };
  if (chord === null) return { ok: true };
  const n = normalizeChord(chord);
  if (n === null) return { ok: false, code: 'BAD_CHORD', message: `${chord} is not a key chord` };
  if (RESERVED_CHORDS.includes(n)) return { ok: false, code: 'RESERVED', message: `${displayChord(n)} is reserved for the browser, the system or the keyboard walk, so it cannot be used` };
  const other = COMMANDS.find((c) => c.id !== id && c.scope === command.scope && bindings[c.id] === n);
  if (other) return { ok: false, code: 'CONFLICT', message: `${displayChord(n)} is already used by "${other.label}"; "${command.label}" cannot share it`, with: [command.label, other.label] };
  return { ok: true };
}

/**
 * The command whose binding is this key event in this scope, or null. Fixed commands count (Escape closes a dialog).
 * @param {Parameters<typeof chordFromEvent>[0]} e @param {string} scope @param {Record<string, string | null>} bindings
 */
export function commandForEvent(e, scope, bindings) {
  const chord = chordFromEvent(e);
  if (chord === null) return null;
  return COMMANDS.find((c) => c.scope === scope && bindings[c.id] === chord)?.id ?? null;
}

/** A chord as CodeMirror spells it (`Mod-Shift-k`). @param {string} chord */
export function toCodeMirror(chord) {
  const n = normalizeChord(chord);
  if (n === null) return null;
  const parts = n.split(/\+(?=.)/);
  const key = parts.pop() ?? '';
  return [...parts, key.length === 1 ? key.toLowerCase() : key].join('-');
}

/** A chord for people: `Ctrl+Shift+K` (`Cmd+...` on a Mac). @param {string | null} chord @param {boolean} [mac] */
export function displayChord(chord, mac = false) {
  if (!chord) return 'none';
  return chord.replace(/^Mod\b/, mac ? 'Cmd' : 'Ctrl');
}

/** The `aria-keyshortcuts` value for a chord. @param {string | null} chord */
export function ariaShortcut(chord) {
  if (!chord) return undefined;
  const parts = chord.split(/\+(?=.)/);
  const key = parts.pop() ?? '';
  if (!parts.includes('Mod')) return [...parts, key].join('+');
  const rest = parts.filter((p) => p !== 'Mod');
  return ['Control', 'Meta'].map((m) => [m, ...rest, key].join('+')).join(' ');
}

/** The scopes in the order the cheat sheet lists them, with their headings. */
export const SCOPES = [
  ['global', 'Everywhere'],
  ['editor', 'In the editor'],
  ['outline', 'In the chapter list'],
  ['board', 'On the Board'],
  ['timeline', 'On the Timeline'],
  ['dialog', 'In dialogs'],
];
