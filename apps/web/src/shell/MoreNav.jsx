import { Link } from '../router.jsx';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { MORE_TABS, tabHref, tabModule } from '../routes.js';
import { TimerChip } from '../writing/TimerPanel.jsx';

/**
 * Insights and Tasks (M07-J02), a second small navigation beside the project tabs, and the time left while a sprint or timer runs. Real links.
 * @param {{ bookId: string, active: string }} props
 */
export function MoreNav({ bookId, active }) {
  const prefs = usePrefs();
  // a page whose module is off (M07-J04) is not offered
  const tabs = MORE_TABS.filter((t) => tabModule(t.key) === null || prefs.moduleOn(/** @type {string} */ (tabModule(t.key))));
  return (
    <nav aria-label="Insights and tasks" className="project-nav more-nav">
      <ul>
        {tabs.map((t) => (
          <li key={t.key}>
            <Link to={tabHref(bookId, t.key)} className="project-tab" aria-current={t.key === active ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
      <TimerChip insightsHref={tabHref(bookId, 'insights')} />
    </nav>
  );
}
