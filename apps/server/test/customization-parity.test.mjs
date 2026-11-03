// M07-J04: the browser code cannot import the server's packages (it talks to /api only), so the few constants both sides need are written twice.
// This test keeps the two copies equal: the format package's (what the server validates and resolves) and the web app's (what the screens show).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUILTIN, BUILTIN_THEMES as FORMAT_THEMES, COMMAND_ID_RE, FONT_FAMILIES, INSPECTOR_SECTIONS as FORMAT_SECTIONS, MODULE_IDS, PANEL_WIDTH_RANGES, RESERVED_CHORDS as FORMAT_RESERVED,
  SHIFTED_SYMBOLS as FORMAT_SHIFTED, THEME_TOKENS as FORMAT_TOKENS, TYPOGRAPHY_RANGES as FORMAT_RANGES, isReservedChord, normalizeChord as formatChord,
} from '../../../packages/format/src/preferences.mjs';
import { DEFAULT_TYPOGRAPHY, FONT_STACKS, INSPECTOR_SECTIONS, LAYOUT_PRESETS, PANEL_WIDTHS, TYPOGRAPHY_RANGES } from '../../web/src/prefs/appearance.js';
import { BUILTIN_THEMES, THEME_TOKENS } from '../../web/src/prefs/themes.js';
import { COMMANDS, RESERVED_CHORDS, SHIFTED_SYMBOLS, isReserved, normalizeChord } from '../../web/src/shortcuts/registry.js';

test('chords: the reserved list, the shifted symbols and the normaliser are the same on both sides', () => {
  assert.deepEqual(RESERVED_CHORDS, FORMAT_RESERVED);
  assert.equal(SHIFTED_SYMBOLS, FORMAT_SHIFTED);
  const samples = ['Mod+W', 'ctrl+w', 'Cmd+Shift+K', 'ctrl+shift+k', 'Alt+F4', 'alt+f4', 'F5', 'Tab', 'Shift+Tab', 'Esc', 'Escape', '?', 'Shift+?', 'Mod+Shift+/', 'Mod+Enter', 'Mod+Alt+M', 'Alt+ArrowUp', 'alt+up', 'Mod++', '+', 'x', '', 'Mod+', 'Hyper+K', 'Mod+Shift+', 'a b'];
  for (const s of samples) {
    assert.equal(normalizeChord(s), formatChord(s), JSON.stringify(s));
    assert.equal(isReserved(s), isReservedChord(s), JSON.stringify(s));
  }
});

test('every command in the registry has a profile-legal id and a default the server would accept in a profile', () => {
  for (const c of COMMANDS) {
    assert.match(c.id, COMMAND_ID_RE, c.id);
    if (!c.fixed && c.binding !== null) assert.ok(!isReservedChord(c.binding), `${c.id} default ${c.binding} must not be reserved`);
    assert.equal(formatChord(c.binding), c.binding, `${c.id} default is in normal form`);
  }
});

test('themes: the same tokens and the same built-in names', () => {
  assert.deepEqual(THEME_TOKENS, FORMAT_TOKENS);
  assert.deepEqual(BUILTIN_THEMES.map((t) => t.name), FORMAT_THEMES);
});

test('typography and layout: the built-in values, the ranges, the fonts and the right-rail sections', () => {
  assert.deepEqual({ ...DEFAULT_TYPOGRAPHY }, { ...BUILTIN.typography });
  assert.deepEqual(Object.keys(FONT_STACKS), FONT_FAMILIES);
  for (const k of Object.keys(FORMAT_RANGES)) {
    const [min, max] = FORMAT_RANGES[k];
    assert.deepEqual([TYPOGRAPHY_RANGES[k].min, TYPOGRAPHY_RANGES[k].max], [min, max], k);
  }
  for (const k of ['rail', 'inspector']) assert.deepEqual([PANEL_WIDTHS[k].min, PANEL_WIDTHS[k].max], PANEL_WIDTH_RANGES[k], k);
  assert.deepEqual(INSPECTOR_SECTIONS, FORMAT_SECTIONS);
  assert.equal(BUILTIN.layout.name, 'Writing');
  assert.ok(LAYOUT_PRESETS[BUILTIN.layout.name]);
  for (const p of Object.values(LAYOUT_PRESETS)) for (const s of p.pinned ?? []) assert.ok(FORMAT_SECTIONS.includes(s), s);
});

test('modules: the Settings list has the same ids as the server, in the same order', () => {
  const text = readFileSync(new URL('../../web/src/prefs/PrefsContext.jsx', import.meta.url), 'utf8');
  const block = text.slice(text.indexOf('export const MODULES'), text.indexOf('];', text.indexOf('export const MODULES')));
  assert.deepEqual([...block.matchAll(/\{ id: '(\w+)'/g)].map((m) => m[1]), MODULE_IDS);
});
