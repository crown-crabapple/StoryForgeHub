// suggest and propose-state (contract M05-J06 sections 3 and 4): build suggestion documents. Pure apart from reading
// the target bytes; the caller creates the files through the store. Nothing here changes a canonical file.
import path from 'node:path';
import { buildSuggestion, suggestionPath } from '@storyforge/suggestions';
import { RefusedError, UsageError, readBytes } from './io.mjs';
import { SLUG_RE, addStateItems, appendToList, eolOf, q, setScalar, slugify, splitFrontMatter, titleOfSlug, ulid, withEol } from './text.mjs';
import { pad2 } from './pack.mjs';

/** @typedef {import('./model.mjs').Model} Model */
/** @typedef {{ rel: string, bytes: Buffer, id: string, target: string, mode: string, source: string }} SuggestionFile */

const SOURCE = 'claude-book';
const THREAD_KINDS = new Set(['promise', 'question', 'mystery', 'subplot', 'arc']);
const NO_VALUE = new Set(['died', 'revived', 'destroyed', 'lost', 'found']);
const STATE_EVENTS = new Set([...NO_VALUE, 'holder', 'location', 'learns', 'knows']);

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * @param {{ targetId: string, targetPath: string, baseBytes: Buffer, proposedText: string, mode: string, slug: string, rationale: string }} o
 * @returns {SuggestionFile}
 */
function make({ targetId, targetPath, baseBytes, proposedText, mode, slug, rationale }) {
  const created = nowIso();
  const id = `note_${ulid()}`;
  const { text } = buildSuggestion({
    id, targetId, targetPath, baseBytes, proposedBytes: Buffer.from(proposedText, 'utf8'), source: SOURCE, mode, rationale, created,
  });
  return { rel: suggestionPath(created, slug), bytes: Buffer.from(text, 'utf8'), id, target: targetId, mode, source: SOURCE };
}

/**
 * suggest: the alternative text becomes a suggestion for one scene. `fromText` is either the whole scene file (it starts with
 * front matter) or just the body, which is placed under the scene's own front matter, byte for byte.
 * @param {{ model: Model, scene: { doc: import('@storyforge/format').Doc }, fromText: string }} o
 * @returns {SuggestionFile}
 */
export function suggestForScene({ model, scene, fromText }) {
  const abs = path.join(model.root, ...scene.doc.rel.split('/'));
  const baseBytes = readBytes(abs);
  const baseText = baseBytes.toString('utf8');
  const split = splitFrontMatter(baseText);
  if (!split) throw new UsageError(`${scene.doc.rel} has no front matter`);
  const eol = eolOf(baseText);
  const proposed = withEol(splitFrontMatter(fromText) ? fromText : `${split.head}${fromText}`, eol);
  try {
    return make({
      targetId: String(scene.doc.fm.id),
      targetPath: scene.doc.rel,
      baseBytes,
      proposedText: proposed,
      mode: 'suggest',
      slug: `${slugify(String(scene.doc.fm.title ?? '')) || 'scene'}-alt`,
      rationale: `Alternative text for "${scene.doc.fm.title ?? scene.doc.rel}", supplied through sf-claude-book. Nothing is applied until you accept a hunk.`,
    });
  } catch (e) {
    if (e?.code === 'NO_CHANGE') throw new RefusedError('NO_CHANGE: the text in --from is identical to the scene');
    throw e;
  }
}

const sameItem = (a, b) => a.slug === b.slug && a.event === b.event && (a.value ?? '') === (b.value ?? '');

/** Whether a state item would pass the validator (E102, E301, E302). @param {Model} model @param {{slug: string, event: string, value?: string}} it */
function stateItemProblem(model, it) {
  const ent = model.find(it.slug, ['entry']);
  if (!ent) return `slug "${it.slug}" is not an entry`;
  const type = ent.fm.type;
  const valueEntry = (v, types) => {
    const e = model.find(v, ['entry']);
    return e && types.includes(e.fm.type) ? null : `value "${v}" is not a ${types.join(' or ')} entry`;
  };
  switch (it.event) {
    case 'died': case 'revived': return type === 'character' ? null : `"${it.slug}" is not a character`;
    case 'destroyed': case 'lost': case 'found': return null;
    case 'holder': return type !== 'object' ? `"${it.slug}" is not an object` : it.value === '' ? null : valueEntry(it.value, ['character']);
    case 'location': return type !== 'character' && type !== 'object' ? `"${it.slug}" is not a character or object` : valueEntry(it.value, ['location']);
    case 'learns': case 'knows': return type !== 'character' ? `"${it.slug}" is not a character` : SLUG_RE.test(it.value) ? null : `fact key "${it.value}" is not slug-shaped`;
    default: return `unknown event "${it.event}"`;
  }
}

/**
 * Normalise the state-updater's state_events and knowledge into validated state items; the rest go to `notes`.
 * @param {Model} model @param {number} chapter @param {any} data @param {string[]} notes
 */
function collectStateItems(model, chapter, data, notes) {
  /** @type {{ slug: string, event: string, value?: string }[]} */
  const items = [];
  const add = (it, from) => {
    const problem = it.event && STATE_EVENTS.has(it.event) ? stateItemProblem(model, it) : `unknown event "${it.event}"`;
    if (problem) notes.push(`skipped ${from}: ${problem}`);
    else if (!items.some((x) => sameItem(x, it))) items.push(it);
  };
  for (const e of Array.isArray(data.state_events) ? data.state_events : []) {
    if (!e || typeof e.slug !== 'string' || typeof e.event !== 'string') { notes.push('skipped a state_events item without slug and event'); continue; }
    const it = { slug: e.slug, event: e.event };
    if (!NO_VALUE.has(e.event)) it.value = typeof e.value === 'string' ? e.value : '';
    add(it, `state event ${e.slug}/${e.event}`);
  }
  for (const k of Array.isArray(data.knowledge) ? data.knowledge : []) {
    const fact = slugify(String(k?.knows ?? ''));
    if (!k || typeof k.character !== 'string' || fact === '') { notes.push('skipped a knowledge item without character and knows'); continue; }
    const learned = Number(k.learned_in);
    add({ slug: k.character, event: Number.isFinite(learned) && learned !== chapter ? 'knows' : 'learns', value: fact }, `knowledge ${k.character}/${fact}`);
  }
  return items;
}

const stateLines = (items) => items.map((it) => `  - { slug: ${q(it.slug)}, event: ${q(it.event)}${it.value === undefined ? '' : `, value: ${q(it.value)}`} }`);

/**
 * @param {{ model: Model, chapter: number, data: any }} o data = the state-updater's chapter-NN-ledgers.json
 * @returns {{ files: SuggestionFile[], notes: string[] }}
 */
export function proposeState({ model, chapter, data }) {
  const notes = [];
  const files = [];
  const scenes = model.chapterScenes(chapter);
  if (scenes.length === 0) throw new UsageError(`chapter ${chapter} has no scenes in this book`);
  const nn = pad2(chapter);
  const sceneIds = scenes.map((s) => String(s.doc.fm.id));
  const rationale = (what) => `Proposed from chapter ${chapter} by sf-claude-book: ${what}. Review before use; nothing is applied until you accept a hunk.`;
  const usedPaths = new Set();
  const exists = (rel) => model.docs.some((d) => d.rel === rel);
  const guard = (fn, label) => {
    try {
      const f = fn();
      if (f) files.push(f);
    } catch (e) {
      if (e instanceof UsageError) throw e;
      notes.push(`skipped ${label}: ${e instanceof RefusedError ? e.message : e?.code === 'NO_CHANGE' ? 'no change' : e.message}`);
    }
  };

  // 1. state_events / knowledge -> state items on the chapter's event, or a new event file
  const items = collectStateItems(model, chapter, data, notes);
  if (items.length > 0) {
    const titleRe = new RegExp(`^chapter\\s+0*${chapter}(?!\\d)`, 'i');
    const ev = model.events.find((e) => model.narrativeChapter(e) === chapter && titleRe.test(String(e.fm.title ?? '')));
    if (ev) {
      const have = Array.isArray(ev.fm.state) ? ev.fm.state.filter((x) => x && typeof x === 'object') : [];
      const fresh = items.filter((it) => !have.some((h) => sameItem(h, it)));
      if (fresh.length === 0) notes.push(`state items already recorded on ${ev.rel}`);
      else {
        guard(() => {
          const baseBytes = readBytes(path.join(model.root, ...ev.rel.split('/')));
          return make({
            targetId: String(ev.fm.id), targetPath: ev.rel, baseBytes, proposedText: addStateItems(baseBytes.toString('utf8'), fresh),
            mode: 'state', slug: `chapter-${nn}-state`, rationale: rationale(`state items for the event "${ev.fm.title}"`),
          });
        }, `state items for ${ev.rel}`);
      }
    } else {
      const rel = `planning/timeline/chapter-${nn}-state.md`;
      if (exists(rel)) notes.push(`skipped new event: ${rel} already exists but is not the chapter's event`);
      else {
        const orders = model.events.map((e) => e.fm.order);
        const order = orders.length > 0 ? Math.floor(Math.max(...orders)) + 10 : 10;
        const text = [
          '---', 'schema: storyforge.event/v1', `id: event_${ulid()}`, `slug: chapter-${nn}-state`, `title: ${q(`Chapter ${chapter}`)}`,
          `order: ${order}`, `scenes: [${sceneIds.join(', ')}]`, 'state:', ...stateLines(items), '---',
          `Proposed from chapter ${chapter} — review before use.`, '',
        ].join('\n');
        guard(() => make({ targetId: '', targetPath: rel, baseBytes: Buffer.alloc(0), proposedText: text, mode: 'state', slug: `chapter-${nn}-state`, rationale: rationale('a new timeline event holding the chapter\'s state items') }), rel);
      }
    }
  }

  // 2. ledger items -> new thread files (plant) or a hunk on the existing thread (payoff)
  for (const li of Array.isArray(data.ledger_items) ? data.ledger_items : []) {
    if (!li || typeof li !== 'object') continue;
    if (typeof li.payoff_in !== 'undefined' && typeof li.slug === 'string') {
      const th = model.find(li.slug, ['thread']);
      if (!th) { notes.push(`skipped payoff of "${li.slug}": no such thread`); continue; }
      const pc = Number(li.payoff_in);
      const payScene = (Number.isInteger(pc) && model.chapterScenes(pc)[0]) || scenes[0];
      const sceneId = String(payScene.doc.fm.id);
      if ((Array.isArray(th.fm.payoff) ? th.fm.payoff : []).includes(sceneId) && th.fm.status === 'paid') { notes.push(`payoff of "${li.slug}" already recorded`); continue; }
      guard(() => {
        const baseBytes = readBytes(path.join(model.root, ...th.rel.split('/')));
        let t = setScalar(baseBytes.toString('utf8'), 'status', 'paid');
        if (!(Array.isArray(th.fm.payoff) ? th.fm.payoff : []).includes(sceneId)) t = appendToList(t, 'payoff', sceneId);
        return make({
          targetId: String(th.fm.id), targetPath: th.rel, baseBytes, proposedText: t, mode: 'state',
          slug: `${li.slug}-payoff`, rationale: rationale(`payoff of the thread "${th.fm.title}"`),
        });
      }, `payoff of ${li.slug}`);
    } else if (typeof li.title === 'string' && li.title.trim() !== '') {
      const slug = slugify(li.title);
      const rel = `planning/threads/${slug}.md`;
      if (slug === '' || model.find(slug, ['thread']) || exists(rel) || usedPaths.has(rel)) { notes.push(`skipped plant "${li.title}": a thread with that slug already exists`); continue; }
      usedPaths.add(rel);
      const kind = THREAD_KINDS.has(li.kind) ? li.kind : 'promise';
      if (kind !== li.kind) notes.push(`plant "${li.title}": kind "${li.kind}" is not a StoryForge thread kind, proposed as "promise"`);
      const chars = (Array.isArray(li.characters) ? li.characters : []).filter((c) => typeof c === 'string' && model.find(c, ['entry'])?.fm.type === 'character');
      const text = [
        '---', 'schema: storyforge.thread/v1', `id: thread_${ulid()}`, `slug: ${slug}`, `title: ${q(li.title.trim())}`, `kind: ${kind}`, 'status: planted',
        `setup: [${sceneIds[0]}]`, 'develop: []', 'payoff: []', `characters: [${chars.join(', ')}]`, '---',
        `Proposed from chapter ${chapter} — review before use.`, '',
      ].join('\n');
      guard(() => make({ targetId: '', targetPath: rel, baseBytes: Buffer.alloc(0), proposedText: text, mode: 'state', slug: `thread-${slug}`, rationale: rationale(`a new thread "${li.title}" planted in this chapter`) }), `thread ${slug}`);
    } else {
      notes.push('skipped a ledger item that is neither a plant (title) nor a payoff (slug, payoff_in)');
    }
  }

  // 3. unknown slugs -> seed entries (mode canon), never canon status
  const cast = new Set((Array.isArray(data.cast) ? data.cast : []).map((c) => c?.slug).filter((s) => typeof s === 'string'));
  for (const slug of Array.isArray(data.unknown_slugs) ? data.unknown_slugs : []) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) { notes.push(`skipped unknown slug ${JSON.stringify(slug)}: not slug-shaped`); continue; }
    if (model.find(slug, ['entry'])) { notes.push(`skipped unknown slug "${slug}": an entry with that slug exists`); continue; }
    const type = cast.has(slug) ? 'character' : 'lore';
    const rel = `codex/${type === 'character' ? 'characters' : 'lore'}/${slug}.md`;
    if (exists(rel) || usedPaths.has(rel)) { notes.push(`skipped unknown slug "${slug}": ${rel} already exists`); continue; }
    usedPaths.add(rel);
    const text = [
      '---', 'schema: storyforge.entry/v1', `id: entry_${ulid()}`, `slug: ${slug}`, `type: ${type}`, `name: ${q(titleOfSlug(slug))}`, 'status: seed', '---',
      `Proposed from chapter ${chapter} — review before use.`, '',
    ].join('\n');
    guard(() => make({ targetId: '', targetPath: rel, baseBytes: Buffer.alloc(0), proposedText: text, mode: 'canon', slug: `entry-${slug}`, rationale: rationale(`a new seed entry for "${slug}", which the chapter mentions but the codex lacks`) }), `entry ${slug}`);
  }
  return { files, notes };
}
