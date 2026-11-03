// The CodeMirror side of the shortcut registry (M07-J04): one catch-all key binding that asks the registry which command (if any) the key press is, so a rebound shortcut
// takes effect at once without rebuilding the editor. `getBindings` is read on every key press.
import { keymap } from '@codemirror/view';
import { commandForEvent } from './registry.js';

/**
 * @param {() => Record<string, string | null>} getBindings the current bindings (command id -> chord)
 * @param {Record<string, (view: import('@codemirror/view').EditorView) => boolean | void>} run the handler of each command this editor carries out
 * @param {string} [scope]
 */
export function registryKeymap(getBindings, run, scope = 'editor') {
  return keymap.of([
    {
      any: (view, event) => {
        const id = commandForEvent(event, scope, getBindings());
        const fn = id === null ? undefined : run[id];
        if (!fn) return false;
        event.preventDefault();
        fn(view);
        return true;
      },
    },
  ]);
}
