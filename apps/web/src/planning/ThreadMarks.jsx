import { ROLES } from './model.js';

/**
 * "Mark this scene as setup / development / payoff" for one plot thread of the scene rail. Each button is pressed when the thread's own lists already hold the
 * scene; pressing it adds the scene to (or removes it from) that list of the thread file. Presentational: `onMark(thread, list, present)` does the write.
 * @param {{ thread: { id: string, title: string, setup: string[], develop: string[], payoff: string[] }, sceneId: string, onMark: (thread: any, list: string, present: boolean) => void }} props
 */
export function ThreadMarks({ thread, sceneId, onMark }) {
  return (
    <div className="thread-marks" role="group" aria-label={`Mark this scene as, for ${thread.title}`}>
      <span className="thread-marks-label">Mark this scene as</span>
      {ROLES.map((r) => {
        const on = thread[r.list].includes(sceneId);
        return (
          <button key={r.list} type="button" className="btn row-button" data-list={r.list} aria-pressed={on ? 'true' : 'false'} onClick={() => onMark(thread, r.list, !on)}>
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The `threadActions` of the rail's "In this scene" list for a scene: the marks of every item that is a plot thread the planning answer knows.
 * @param {{ planning: { threads: any[] } | null | undefined, sceneId: string, onMark: (thread: any, list: string, present: boolean) => void }} p
 * @returns {(item: { id: string | null, group: string }) => import('react').ReactNode}
 */
export function threadActionsFor({ planning, sceneId, onMark }) {
  return (item) => {
    if (item.group !== 'threads' || !item.id) return null;
    const thread = planning?.threads?.find((t) => t.id === item.id);
    return thread ? <ThreadMarks thread={thread} sceneId={sceneId} onMark={onMark} /> : null;
  };
}
