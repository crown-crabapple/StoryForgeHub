import { Link } from '../router.jsx';
import { MORE_TABS, tabHref } from '../routes.js';
import { TimerChip } from '../writing/TimerPanel.jsx';

/**
 * Insights and Tasks (M07-J02), a second small navigation beside the project tabs, and the time left while a sprint or timer runs. Real links.
 * @param {{ bookId: string, active: string }} props
 */
export function MoreNav({ bookId, active }) {
  return (
    <nav aria-label="Insights and tasks" className="project-nav more-nav">
      <ul>
        {MORE_TABS.map((t) => (
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
