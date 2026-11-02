// After an in-app page change, focus that fell to <body> moves to the new page's <main>; focus held elsewhere is left alone (M06-J03 coordinator walk).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installFocusRestore } from '../src/shell/focus-restore.js';
import { NAV_EVENT } from '../src/nav-event.js';

function fakeDom(active) {
  const listeners = {};
  const main = { focused: false, focus() { this.focused = true; } };
  const body = {};
  const doc = { body, activeElement: active === 'body' ? body : active, getElementById: (id) => (id === 'main' ? main : null) };
  const win = { addEventListener: (t, f) => (listeners[t] = f), removeEventListener: (t) => delete listeners[t] };
  return { doc, win, main, fire: (t) => listeners[t]?.() };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('focus lost to body after navigation goes to main', async () => {
  const d = fakeDom('body');
  const off = installFocusRestore(d.doc, d.win);
  d.fire(NAV_EVENT);
  await tick(10);
  assert.equal(d.main.focused, true);
  off();
});

test('focus the user holds is not taken', async () => {
  const d = fakeDom({ tagName: 'INPUT' });
  const off = installFocusRestore(d.doc, d.win);
  d.fire('popstate');
  await tick(10);
  assert.equal(d.main.focused, false);
  off();
});
