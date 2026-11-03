import { Link } from '../router.jsx';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { PROJECT_TABS, tabHref, tabModule } from '../routes.js';

/** Manuscript · Codex · Timeline · Places · Notes, as real links. @param {{ bookId: string, active: string }} props */
export function ProjectNav({ bookId, active }) {
  const prefs = usePrefs(); // a tab of a module that is off is not drawn (M07-J04)
  return (
    <nav aria-label="Project" className="project-nav">
      <ul>
        {PROJECT_TABS.filter((t) => tabModule(t.key) === null || prefs.moduleOn(/** @type {string} */ (tabModule(t.key)))).map((t) => (
          <li key={t.key}>
            <Link to={tabHref(bookId, t.key)} className="project-tab" aria-current={t.key === active ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
