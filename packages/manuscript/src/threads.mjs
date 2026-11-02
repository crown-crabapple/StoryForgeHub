// Plot-thread commands (M04-J03): new thread, thread state, and the setup / develop / payoff / characters lists. Every one has a dry run,
// goes through the store (one batch, one opId), is refused when it would add a validation error, and never deletes.
// The state is a single front-matter line (editFrontMatterLine); a list is replaced as that key's own block (replaceFrontMatterBlock).
// YAML is never re-serialised, and the thread's text (the body) is not touched here.
import { editFrontMatterLine, formatYamlText } from './frontmatter.mjs';
import { flowList, frontOf, prepareCodex, replaceFrontMatterBlock, slugTaken, stale } from './codex.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { SLUG_RE, slugify, ulid } from './util.mjs';

/** Every state a thread may have: the six current ones, then the legacy `open` and `abandoned`. */
export const THREAD_STATUSES = ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved', 'open', 'abandoned'];
export const THREAD_KINDS = ['promise', 'question', 'mystery', 'subplot', 'arc'];
/** The scene lists of a thread, in file order. */
export const THREAD_LISTS = ['setup', 'develop', 'payoff'];
const LIST_AFTER = { setup: ['status'], develop: ['setup', 'status'], payoff: ['develop', 'setup', 'status'], characters: ['payoff', 'develop', 'setup', 'status'] };
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SCENE_REF_RE = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The live thread document for an id or slug. */
const findThread = (docs, ref) => docs.find((d) => d.kind === 'thread' && !d.archived && (d.fm.id === ref || d.fm.slug === ref)) ?? null;

// ------------------------------------------------------------------ createThread

/**
 * New thread file planning/threads/<slug>.md: schema, id, slug, title, kind, status, empty setup / develop / payoff lists and an empty body.
 * A slug used by another entry, thread or event: SLUG_TAKEN.
 * @param {string} bookRoot
 * @param {{ title: string, slug?: string, kind?: string, status?: string, dryRun?: boolean }} args
 */
export function createThread(bookRoot, args = {}) {
  return guarded(async () => {
    const { title, slug: given, kind = 'subplot', status = 'planned', dryRun = false } = args ?? {};
    if (!isText(title) || title.trim() === '' || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    if (!THREAD_KINDS.includes(kind)) return fail('REFUSED_BAD_ARGS', `kind must be one of ${THREAD_KINDS.join(', ')}`);
    if (!THREAD_STATUSES.includes(status)) return fail('REFUSED_BAD_ARGS', `status must be one of ${THREAD_STATUSES.join(', ')}`);
    const slug = given !== undefined && given !== null && given !== '' ? given : slugify(title);
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 60) {
      return fail('REFUSED_BAD_ARGS', given ? 'slug must be lower-case letters, digits and single hyphens (1-60 characters)' : 'the title has no letters or digits to make a slug from; give a slug');
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    if (slugTaken(docs, slug)) return fail('SLUG_TAKEN', `the slug "${slug}" is already used by another entry, thread or event`, { slug });

    const id = `thread_${ulid()}`;
    const to = `planning/threads/${slug}.md`;
    const text =
      `---\nschema: storyforge.thread/v1\nid: ${id}\nslug: ${formatYamlText(slug)}\ntitle: ${formatYamlText(title)}\nkind: ${kind}\nstatus: ${status}\n` +
      'setup: []\ndevelop: []\npayoff: []\n---\n';
    const changes = [{ from: null, to, content: Buffer.from(text, 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createThread', args: { title, slug, kind, status }, changes, dryRun, withDiff: true, extra: { id, slug, path: to } });
  });
}

// ------------------------------------------------------------------ setThreadFields

/**
 * Edit a thread's front matter. `status`: its own line. `setup`, `develop`, `payoff` (lists of scene ids) and `characters` (codex slugs or ids):
 * that key's block is replaced, nothing else; a key the file lacks is inserted after the previous list (an empty list for a missing key changes nothing).
 * `add` / `remove` ({ setup?: string[], develop?: string[], payoff?: string[] }) change the file's current list instead of replacing it,
 * so an item the author wrote by hand that does not resolve is kept. A block with a comment, anchor or tag: REFUSED_UNSIMPLE_FIELD.
 * `baseSha256`: the file as the author saw it; another file on disk is CONFLICT.
 * @param {string} bookRoot @param {string} ref thread id or slug
 * @param {{ status?: string, setup?: string[], develop?: string[], payoff?: string[], characters?: string[],
 *   add?: Record<string, string[]>, remove?: Record<string, string[]>, dryRun?: boolean, baseSha256?: string }} args
 */
export function setThreadFields(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { status, setup, develop, payoff, characters, add, remove, dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the thread must be an id or slug');
    const replace = { setup, develop, payoff, characters };
    if (status === undefined && add === undefined && remove === undefined && Object.values(replace).every((v) => v === undefined)) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    if (status !== undefined && !THREAD_STATUSES.includes(status)) return fail('REFUSED_BAD_ARGS', `status must be one of ${THREAD_STATUSES.join(', ')}`);
    const sceneIds = (v) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string' && SCENE_REF_RE.test(x));
    for (const key of THREAD_LISTS) {
      if (replace[key] !== undefined && !sceneIds(replace[key])) return fail('REFUSED_BAD_ARGS', `${key} must be a list of scene ids`);
    }
    if (characters !== undefined && !(Array.isArray(characters) && characters.length <= 200 && characters.every((c) => typeof c === 'string' && c !== '' && isText(c)))) {
      return fail('REFUSED_BAD_ARGS', 'characters must be a list of codex slugs or ids');
    }
    for (const [name, delta] of [['add', add], ['remove', remove]]) {
      if (delta === undefined) continue;
      if (!isMap(delta) || Object.keys(delta).length === 0 || Object.entries(delta).some(([k, v]) => !THREAD_LISTS.includes(k) || !sceneIds(v))) {
        return fail('REFUSED_BAD_ARGS', `${name} must be { setup?, develop?, payoff? }, each a list of scene ids`);
      }
    }

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findThread(docs, ref);
    if (!doc) return fail('REFUSED_UNKNOWN_THREAD', `no thread ${ref}`);
    const scenes = new Set(docs.filter((d) => d.kind === 'scene' && !d.archived && typeof d.fm.id === 'string').map((d) => d.fm.id));
    const unknown = [...THREAD_LISTS.flatMap((k) => replace[k] ?? []), ...Object.values(add ?? {}).flat()].find((id) => !scenes.has(id));
    if (unknown) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${unknown} in the book`, { scene: unknown });
    if (characters !== undefined) {
      const entries = docs.filter((d) => d.kind === 'entry' && !d.archived);
      const missing = characters.find((c) => !entries.some((e) => e.fm.slug === c || e.fm.id === c));
      if (missing) return fail('REFUSED_UNKNOWN_ENTRY', `no codex entry ${missing}`, { entry: missing });
    }

    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    let buf = before;
    if (status !== undefined) {
      const r = editFrontMatterLine(buf, 'status', status, { plain: true });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: r.field });
      buf = r.buf;
    }
    const has = (key) => new RegExp(`^${key}:`, 'm').test(frontOf(buf));
    const current = (key) => (Array.isArray(doc.fm[key]) ? doc.fm[key].filter((x) => typeof x === 'string') : []);
    for (const key of [...THREAD_LISTS, 'characters']) {
      let list = replace[key];
      if (list === undefined && (add?.[key] || remove?.[key])) {
        const drop = new Set(remove?.[key] ?? []);
        list = current(key).filter((x) => !drop.has(x));
        for (const id of add?.[key] ?? []) if (!list.includes(id)) list.push(id);
      }
      if (list === undefined) continue;
      list = list.filter((x, i) => list.indexOf(x) === i);
      if (list.length === 0 && !has(key)) continue; // an empty list for a key the file does not have changes nothing
      const r = replaceFrontMatterBlock(buf, key, flowList(key, list), { after: LIST_AFTER[key] });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: key });
      buf = r.buf;
    }
    const changes = buf.equals(before) ? [] : [{ from: doc.rel, to: doc.rel, content: buf, before }];
    return finish({
      bookRoot,
      store,
      lb,
      op: 'setThreadFields',
      args: { ref, status, setup: setup?.length, develop: develop?.length, payoff: payoff?.length, characters: characters?.length, add, remove },
      changes,
      dryRun,
      withDiff: true,
      extra: { id: doc.fm.id, path: doc.rel },
    });
  });
}
