// Goals and revision tasks (M07-J02): the checks that need the book's other documents.
//   E301  a goal's `scope` is not the ID of a chapter or act of this book (at goals[i].scope)
//   W313  a task target's `id` is not a document of this book (at targets[i].id)
// Shape problems (E102) are checked with the other fields, in schema.mjs.

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkActivity(docs, add) {
  const containers = new Set();
  const ids = new Set();
  for (const d of docs) {
    if (typeof d.fm.id !== 'string') continue;
    ids.add(d.fm.id);
    if (!d.archived && (d.kind === 'chapter' || d.kind === 'act')) containers.add(d.fm.id);
  }
  for (const d of docs) {
    if (d.archived) continue;
    if (d.kind === 'goals' && Array.isArray(d.fm.goals)) {
      d.fm.goals.forEach((g, i) => {
        if (g && typeof g === 'object' && typeof g.scope === 'string' && g.scope !== '' && !containers.has(g.scope)) {
          add('E301', d.file, `goals[${i}].scope`, `cannot resolve ${g.scope}: a goal's scope is a chapter or act ID of this book`);
        }
      });
    } else if (d.kind === 'task' && Array.isArray(d.fm.targets)) {
      d.fm.targets.forEach((t, i) => {
        if (t && typeof t === 'object' && typeof t.id === 'string' && t.id !== '' && !ids.has(t.id)) {
          add('W313', d.file, `targets[${i}].id`, `task target ${t.id} is not a document of this book`);
        }
      });
    }
  }
}
