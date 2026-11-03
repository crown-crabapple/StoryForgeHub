import { Link } from '../router.jsx';
import { MORE_TABS, PROJECT_TABS, tabHref } from '../routes.js';
import { TimerChip } from '../writing/TimerPanel.jsx';

/** Manuscript · Codex · Timeline · Places · Notes, as real links. @param {{ bookId: string, active: string }} props */
export function ProjectNav({ bookId, active }) {
  return (
    <nav aria-label="Project" className="project-nav">
      <ul>
        {[...PROJECT_TABS, ...MORE_TABS].map((t) => (
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
