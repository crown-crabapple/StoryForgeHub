// Running a custom prompt component or workflow step (M07-J04 contract section 6). This only PREPARES a request: it reads the library's prompt, the inputs the author
// chose, and returns the instruction and the list of files the existing context preview (M05-J04) will show. Nothing is sent here; the author presses Send on every step.
import { renderPrompt } from '@storyforge/format';

const refusal = (status, code, message) => ({ ok: false, status, code, message });

/** Book-relative form of a library-relative path. @param {string} bookPath @param {string} p */
const bookRel = (bookPath, p) => (bookPath && p.startsWith(`${bookPath}/`) ? p.slice(bookPath.length + 1) : p);

/**
 * @param {any} repository @param {string} bookId
 * @param {{ slug?: unknown, workflow?: unknown, step?: unknown, previous?: unknown, inputs?: Record<string, any> }} spec what the client sent as `prompt`
 * @returns {Promise<{ ok: true, task: 'chat' | 'rewrite', instruction: string, files: string[], selection: { sceneId: string, from: number, to: number } | null,
 *   sources: { input: string, label: string, path: string | null }[], prompt: { slug: string, name: string, task: string, workflow: string | null, step: number | null, steps: number | null } }
 *   | { ok: false, status: number, code: string, message: string }>}
 */
export async function resolvePromptRun(repository, bookId, spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return refusal(400, 'BAD_ARGS', 'prompt must be an object: { slug } or { workflow, step }');
  const inputs = spec.inputs !== null && typeof spec.inputs === 'object' && !Array.isArray(spec.inputs) ? spec.inputs : {};
  if (spec.previous !== undefined && typeof spec.previous !== 'string') return refusal(400, 'BAD_ARGS', 'previous must be text');
  const library = await repository.listPrompts();

  let slug = typeof spec.slug === 'string' ? spec.slug : null;
  let workflow = null;
  let step = null;
  if (spec.workflow !== undefined) {
    workflow = library.workflows.find((w) => w.slug === spec.workflow) ?? null;
    if (!workflow) return refusal(404, 'PROMPT_NOT_FOUND', `there is no workflow ${String(spec.workflow)} in _prompts/workflows/`);
    if (workflow.problems.length > 0) return refusal(400, 'PROMPT_INVALID', `the workflow ${workflow.slug} has problems: ${workflow.problems[0].location}: ${workflow.problems[0].message}`);
    step = spec.step === undefined ? 0 : spec.step;
    if (!Number.isInteger(step) || step < 0 || step >= workflow.steps.length) return refusal(400, 'BAD_ARGS', `step must be a whole number from 0 to ${workflow.steps.length - 1}`);
    slug = workflow.steps[step];
  }
  if (slug === null) return refusal(400, 'BAD_ARGS', 'prompt needs a slug (or a workflow and a step)');
  const prompt = library.prompts.find((p) => p.slug === slug);
  if (!prompt) return refusal(404, 'PROMPT_NOT_FOUND', `there is no prompt ${slug} in _prompts/`);
  if (prompt.problems.length > 0) return refusal(400, 'PROMPT_INVALID', `the prompt ${slug} has problems: ${prompt.problems[0].location}: ${prompt.problems[0].message}`);

  const book = await repository.getBook(bookId);
  if (!book) return refusal(404, 'NOT_FOUND', 'no such book');
  const rel = (p) => bookRel(book.path ?? '', p);
  /** @type {string[]} */
  const files = [];
  /** @type {{ input: string, label: string, path: string | null }[]} */
  const sources = [];
  const add = (input, label, p) => {
    sources.push({ input, label, path: p });
    if (p && !files.includes(p)) files.push(p);
  };
  const missing = (input) => refusal(400, 'MISSING_INPUT', `the prompt ${slug} needs the ${input} input`);
  /** @type {Record<string, any>} */
  const values = { previous: typeof spec.previous === 'string' ? spec.previous : '' };
  /** @type {{ sceneId: string, from: number, to: number } | null} */
  let selection = null;

  // the scene the run is about (also where the point of view and the chapter come from)
  const sceneId = typeof inputs.sceneId === 'string' ? inputs.sceneId : typeof inputs.selection?.sceneId === 'string' ? inputs.selection.sceneId : null;
  const scene = sceneId ? await repository.getScene(book.id ?? bookId, sceneId) : null;
  if (sceneId && !scene) return refusal(404, 'NOT_FOUND', `no such scene: ${sceneId}`);

  if (prompt.inputs.includes('selection')) {
    const s = inputs.selection;
    if (!s || typeof s.sceneId !== 'string' || !Number.isInteger(s.from) || !Number.isInteger(s.to)) return missing('selection');
    const r = await repository.readAiSelection(bookId, s.sceneId, { from: s.from, to: s.to });
    if (!r.ok) return refusal(r.code === 'NOT_FOUND' ? 404 : 400, r.code ?? 'BAD_SELECTION', r.message ?? 'bad selection');
    selection = { sceneId: s.sceneId, from: s.from, to: s.to };
    values.selection = prompt.task === 'rewrite' ? 'the passage below' : r.text;
    sources.push({ input: 'selection', label: `Selected text (${r.text.length} characters)`, path: null });
  }
  if (prompt.inputs.includes('scene')) {
    if (!scene) return missing('scene');
    add('scene', `Scene: ${scene.title ?? scene.id}`, rel(scene.path));
    values.scene = `the scene "${scene.title ?? scene.id}" (file ${rel(scene.path)}, included below)`;
  }
  if (prompt.inputs.includes('chapter')) {
    const chapterNo = Number.isInteger(inputs.chapter) ? inputs.chapter : scene?.chapter;
    const chapter = book.acts?.flatMap((a) => a.chapters).find((c) => c.chapter === chapterNo);
    if (!chapter) return missing('chapter');
    for (const s of chapter.scenes) add('chapter', `Chapter ${chapter.chapter} scene: ${s.title ?? s.id}`, rel(s.path));
    values.chapter = `chapter ${chapter.chapter}${chapter.title ? ` "${chapter.title}"` : ''} (${chapter.scenes.length} scene${chapter.scenes.length === 1 ? '' : 's'}, included below)`;
  }

  const refs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '') : []);
  const needEntries = prompt.inputs.includes('entries') || prompt.inputs.includes('pov-entry');
  const codex = needEntries ? await repository.listCodexEntries(bookId) : null;
  const entryOf = (ref) => codex?.entries.find((e) => !e.archived && (e.id === ref || e.slug === ref)) ?? null;
  const entryRecord = (e) => ({ name: e.name ?? e.slug, slug: e.slug ?? '', type: e.type ?? '', role: e.role ?? '', status: e.status ?? '', body: `(the full text is in file ${rel(e.path)})` });
  if (prompt.inputs.includes('pov-entry')) {
    const ref = typeof inputs.povEntry === 'string' && inputs.povEntry !== '' ? inputs.povEntry : typeof scene?.front_matter?.pov === 'string' ? scene.front_matter.pov : null;
    const e = ref ? entryOf(ref) : null;
    if (!e) return missing('pov-entry');
    add('pov-entry', `Point of view: ${e.name ?? e.slug}`, rel(e.path));
    values['pov-entry'] = entryRecord(e);
  }
  if (prompt.inputs.includes('entries')) {
    const list = refs(inputs.entries);
    if (list.length === 0) return missing('entries');
    values.entries = [];
    for (const ref of list) {
      const e = entryOf(ref);
      if (!e) return refusal(404, 'NOT_FOUND', `no such entry: ${ref}`);
      add('entries', `Entry: ${e.name ?? e.slug}`, rel(e.path));
      values.entries.push(entryRecord(e));
    }
  }
  if (prompt.inputs.includes('threads')) {
    const list = refs(inputs.threads);
    if (list.length === 0) return missing('threads');
    const all = await repository.listThreads(bookId);
    values.threads = [];
    for (const ref of list) {
      const t = all?.threads.find((x) => x.id === ref || x.slug === ref);
      if (!t) return refusal(404, 'NOT_FOUND', `no such thread: ${ref}`);
      add('threads', `Thread: ${t.title ?? t.slug}`, rel(t.path));
      values.threads.push({ title: t.title ?? t.slug, slug: t.slug ?? '', kind: t.kind ?? '', status: t.status ?? '', body: `(the full text is in file ${rel(t.path)})` });
    }
  }
  if (prompt.inputs.includes('notes')) {
    const list = refs(inputs.notes);
    if (list.length === 0) return missing('notes');
    const all = await repository.listNotes(bookId);
    values.notes = [];
    for (const id of list) {
      const n = all?.notes.find((x) => x.id === id && !x.archived);
      if (!n) return refusal(404, 'NOT_FOUND', `no such note: ${id}`);
      add('notes', `Note: ${n.title ?? n.id}`, n.rel);
      values.notes.push({ title: n.title ?? n.id, tags: n.tags ?? [], body: `(the full text is in file ${n.rel})` });
    }
  }

  const rendered = renderPrompt(prompt, values);
  if (rendered.missing.length > 0) return missing(rendered.missing[0]);
  return {
    ok: true,
    task: prompt.task,
    instruction: rendered.text.trim(),
    files,
    selection,
    sources,
    prompt: { slug: prompt.slug, name: prompt.name, task: prompt.task, workflow: workflow ? workflow.slug : null, step, steps: workflow ? workflow.steps.length : null },
  };
}
