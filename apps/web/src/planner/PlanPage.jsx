import { usePrefs } from '../prefs/PrefsContext.jsx';
import { Link } from '../router.jsx';
import { viewHref } from '../planning/model.js';
import { PLAN_VIEWS, planUrl } from './model.js';

/**
 * The page of the Plan tab: the heading, the Overview · Flow · Structure · Arcs switch, plain links to the Board and Outline of the manuscript, and the view (`children`). Presentational.
 * @param {{ bookId: string, view: 'overview' | 'flow' | 'structure' | 'arcs' | 'synopsis', children?: import('react').ReactNode }} props
 */
export function PlanPage({ bookId, view, children }) {
  const prefs = usePrefs(); // the Board follows its module
  return (
    <main id="main" tabIndex={-1} className="page plan-page">
      <div className="page-head">
        <h1>Plan</h1>
      </div>
      <div className="view-switch plan-switch">
        <nav aria-label="Plan views">
          <ul>
            {PLAN_VIEWS.map((v) => (
              <li key={v.key}>
                <Link to={planUrl(bookId, { view: v.key, node: null, link: null, arc: null, structure: null, mode: null, filter: null })} className="view-tab" aria-current={v.key === view ? 'page' : undefined}>
                  {v.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Manuscript views of the same scenes">
          <ul>
            {prefs.moduleOn('board') && (
              <li>
                <Link to={viewHref(bookId, 'board')} className="view-tab">
                  Board
                </Link>
              </li>
            )}
            <li>
              <Link to={viewHref(bookId, 'outline')} className="view-tab">
                Outline
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      {children}
    </main>
  );
}
