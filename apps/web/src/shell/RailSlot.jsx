import { sectionPlace } from '../prefs/appearance.js';
import { usePrefs } from '../prefs/PrefsContext.jsx';

/**
 * One right-rail section (M07-J04): drawn only when its module is on and the layout pins it, and placed where the layout puts it. With nothing pinned (the Writing layout, and
 * everywhere without preferences) the children are drawn as they always were, with no extra element.
 * @param {{ id: string, module?: string | null, children: import('react').ReactNode }} props `id`: a section of the right rail (see INSPECTOR_SECTIONS); `module`: the module it belongs to
 */
export function RailSlot({ id, module = null, children }) {
  const prefs = usePrefs();
  if (module !== null && !prefs.moduleOn(module)) return null;
  const pinned = prefs.layout.pinned;
  if (pinned === null) return children;
  const place = sectionPlace(pinned, id);
  if (!place.shown) return null;
  return (
    <div className="rail-slot" data-section={id} style={{ order: place.order }}>
      {children}
    </div>
  );
}
