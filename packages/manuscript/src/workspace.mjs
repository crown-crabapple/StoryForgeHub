// Workspace doc commands (M12 W2): the book / style / per-chapter state docs an author and an AI both read and write. A workspace doc is the generic `doc` kind
// (storyforge.doc/v1) under planning/workspace/, planning/state/chapter-NN/ or planning/development/. Every command goes through the store (one batch, one opId,
// so Undo works), is refused when it would add a validation error, and never deletes (archive moves to archive/planning/). An update is guarded by the sha256 the
// caller last saw; a locked doc (`locked: true`) refuses every write except unlocking it.
import { editFrontMatterLine, formatYamlText, frontMatterRange, splitDocument } from './frontmatter.mjs';
import { prepareCodex } from './codex.mjs';
import { fail, finish, guarded } from './ops.mjs';
import { sha256, ulid } from './util.mjs';
import { WORKSPACE_STARTERS } from './workspace-templates.mjs';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
const MAX_BODY = 2 * 1024 * 1024;

/** A doc address: path relative to planning/ without `.md`. development/ is for AI proposals that are never canon. */
export const WORKSPACE_ADDRESS_RE = /^(workspace\/[a-z0-9-]{1,60}|state\/chapter-\d{2,3}\/(situation|characters|knowledge|inventory)|development\/[a-z0-9-]{1,60})$/;
const STATE_FOLDER_RE = /^state\/chapter-\d{2,3}$/;
const STATE_FILE_RE = /^(situation|characters|knowledge|inventory)\.md$/;

/** @param {unknown} addr */
export const isWorkspaceAddress = (addr) => typeof addr === 'string' && WORKSPACE_ADDRESS_RE.test(addr);
/** Book-relative path of a live workspace doc. @param {string} addr */
export const workspacePath = (addr) => `planning/${addr}.md`;

/** { workspace: 'book' | 'style' | 'state' | 'other', chapter: number | null } of an address. @param {string} addr */
export function workspaceInfo(addr) {
  if (addr === 'workspace/book') return { workspace: 'book', chapter: null };
  if (addr === 'workspace/style') return { workspace: 'style', chapter: null };
  const m = /^state\/chapter-(\d{2,3})\//.exec(addr);
  if (m) return { workspace: 'state', chapter: Number(m[1]) };
  return { workspace: 'other', chapter: null };
}

/** A readable default title for an address. @param {string} addr */
export function defaultWorkspaceTitle(addr) {
  const m = /^state\/chapter-(\d{2,3})\/(\w+)$/.exec(addr);
  if (m) return `Chapter ${m[1]} ${m[2]}`;
  const last = addr.split('/').pop() ?? addr;
  const words = last.replace(/-+/g, ' ').trim();
  return words === '' ? 'Document' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Is the front matter of these bytes `locked: true`? @param {Buffer} bytes */
export function isLockedBytes(bytes) {
  const s = bytes.toString('latin1');
  const range = frontMatterRange(s);
  return range !== null && /^locked:[ \t]*true[ \t]*\r?$/m.test(s.slice(range.start, range.end));
}

/** Bytes with the `locked` line set (inserted at the end of the front matter when absent); null without closed front matter. @param {Buffer} bytes @param {boolean} locked */
function withLocked(bytes, locked) {
  const s = bytes.toString('latin1');
  const range = frontMatterRange(s);
  if (!range) return null;
  const region = s.slice(range.start, range.end);
  const eol = region.includes('\r\n') ? '\r\n' : '\n';
  const re = /^locked:[^\r\n]*/m;
  const next = re.test(region) ? region.replace(re, `locked: ${locked}`) : `${region}${region === '' || region.endsWith('\n') ? '' : eol}locked: ${locked}${eol}`;
  return Buffer.from(s.slice(0, range.start) + next + s.slice(range.end), 'latin1');
}

/** The text of a new workspace doc file. @param {string} addr @param {string} title @param {string} body */
function newDocText(addr, title, body) {
  const { workspace, chapter } = workspaceInfo(addr);
  const head = `schema: storyforge.doc/v1\nid: note_${ulid()}\ntitle: ${formatYamlText(title)}\nworkspace: ${workspace}\n${chapter === null ? '' : `chapter: ${chapter}\n`}`;
  return Buffer.from(`---\n${head}---\n${body}`, 'utf8');
}

const lockedRefusal = (addr) => fail('LOCKED', `${addr} is locked; only the author can unlock it`, { path: addr });

/** CONFLICT carrying the file as it is now. @param {string} addr @param {Buffer} cur @param {string} message */
function conflict(addr, cur, message) {
  const split = splitDocument(cur);
  return fail('CONFLICT', message, { file: workspacePath(addr), current: { sha256: sha256(cur), body: cur.subarray(split ? split.bodyStart : 0).toString('utf8') } });
}

const checkAddress = (addr) => (isWorkspaceAddress(addr) ? null : fail('REFUSED_BAD_ARGS', 'path must be workspace/<name>, state/chapter-NN/(situation|characters|knowledge|inventory) or development/<name> (lower-case letters, digits, hyphens)'));

/**
 * Create or update one workspace doc. A new doc needs no base_sha256; an existing one needs the sha256 of the whole file as last read (CONFLICT otherwise, with
 * `current: { sha256, body }`). `title` (optional) sets the title line; `body` is the whole markdown body. A locked doc: LOCKED. An archived doc of that address:
 * REFUSED_PATH_TAKEN. Result extra: { path, sha256, created }.
 * @param {string} bookRoot @param {{ path: string, title?: string, body: string, baseSha256?: string | null, dryRun?: boolean }} args
 */
export function saveWorkspaceDoc(bookRoot, args = {}) {
  return guarded(async () => {
    const { path: addr, title, body, baseSha256, dryRun = false } = args ?? {};
    const bad = checkAddress(addr);
    if (bad) return bad;
    if (typeof body !== 'string' || body.length > MAX_BODY || body.includes('\0')) return fail('REFUSED_BAD_ARGS', 'body must be text (max 2 MB)');
    if (title !== undefined && (!isText(title) || title.trim() === '' || title.length > 300)) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    if (baseSha256 !== undefined && baseSha256 !== null && typeof baseSha256 !== 'string') return fail('REFUSED_BAD_ARGS', 'base_sha256 must be a string');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const rel = workspacePath(addr);
    const cur = await store.read(rel);
    if (!cur) {
      if (typeof baseSha256 === 'string') return fail('NOT_FOUND', `no workspace doc ${addr}`);
      if (await store.exists(`archive/${rel}`)) return fail('REFUSED_PATH_TAKEN', `an archived doc is called ${addr}; restore it or choose another name`, { path: `archive/${rel}` });
      const content = newDocText(addr, title?.trim() ?? defaultWorkspaceTitle(addr), body);
      return finish({ bookRoot, store, lb, op: 'saveWorkspaceDoc', args: { path: addr, created: true }, changes: [{ from: null, to: rel, content, before: null }], dryRun, withDiff: true, extra: { path: addr, sha256: sha256(content), created: true } });
    }
    if (isLockedBytes(cur.bytes)) return lockedRefusal(addr);
    if (typeof baseSha256 !== 'string') return conflict(addr, cur.bytes, `${addr} exists; base_sha256 (the sha256 you read) is required to change it`);
    if (sha256(cur.bytes) !== baseSha256) return conflict(addr, cur.bytes, `${rel} changed on disk since it was read`);
    let head = cur.bytes;
    if (title !== undefined) {
      const t = editFrontMatterLine(head, 'title', title.trim(), { plain: true });
      if (!t.ok) return fail(t.code, t.message, { field: t.field });
      head = t.buf;
    }
    const split = splitDocument(head);
    if (!split) return fail('REFUSED_UNSIMPLE_FIELD', `${rel} has no closed front matter`, { field: 'schema' });
    const content = Buffer.concat([head.subarray(0, split.bodyStart), Buffer.from(body, 'utf8')]);
    if (content.equals(cur.bytes)) return { ok: true, code: 'OK', changes: [], path: addr, sha256: sha256(cur.bytes), created: false };
    return finish({ bookRoot, store, lb, op: 'saveWorkspaceDoc', args: { path: addr, created: false }, changes: [{ from: rel, to: rel, content, before: cur.bytes }], dryRun, withDiff: true, extra: { path: addr, sha256: sha256(content), created: false } });
  });
}

/**
 * Append a block of text to a doc (a blank line between), creating the doc when it is missing. No base_sha256 (an append cannot overwrite anything); a locked doc: LOCKED.
 * @param {string} bookRoot @param {{ path: string, text: string, dryRun?: boolean }} args
 */
export function appendWorkspaceDoc(bookRoot, args = {}) {
  return guarded(async () => {
    const { path: addr, text, dryRun = false } = args ?? {};
    const bad = checkAddress(addr);
    if (bad) return bad;
    if (typeof text !== 'string' || text.trim() === '' || text.length > 200_000 || text.includes('\0')) return fail('REFUSED_BAD_ARGS', 'text must be non-empty text (max 200000 characters)');
    const block = `${text.replace(/\s+$/, '')}\n`;
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const rel = workspacePath(addr);
    const cur = await store.read(rel);
    if (!cur) {
      if (await store.exists(`archive/${rel}`)) return fail('REFUSED_PATH_TAKEN', `an archived doc is called ${addr}; restore it or choose another name`, { path: `archive/${rel}` });
      const content = newDocText(addr, defaultWorkspaceTitle(addr), block);
      return finish({ bookRoot, store, lb, op: 'appendWorkspaceDoc', args: { path: addr, created: true }, changes: [{ from: null, to: rel, content, before: null }], dryRun, withDiff: true, extra: { path: addr, sha256: sha256(content), created: true } });
    }
    if (isLockedBytes(cur.bytes)) return lockedRefusal(addr);
    const split = splitDocument(cur.bytes);
    if (!split) return fail('REFUSED_UNSIMPLE_FIELD', `${rel} has no closed front matter`, { field: 'schema' });
    const body = cur.bytes.subarray(split.bodyStart).toString('utf8');
    const lead = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    const content = Buffer.concat([cur.bytes, Buffer.from(`${lead}${block}`, 'utf8')]);
    return finish({ bookRoot, store, lb, op: 'appendWorkspaceDoc', args: { path: addr, created: false }, changes: [{ from: rel, to: rel, content, before: cur.bytes }], dryRun, withDiff: true, extra: { path: addr, sha256: sha256(content), created: false } });
  });
}

/**
 * Lock or unlock one doc (`path`) or every state doc of one chapter folder (`prefix`, state/chapter-NN). Docs already in that state are left alone. The only write a locked doc accepts.
 * Result extra: { locked, changed: [address], matched: [address] }.
 * @param {string} bookRoot @param {{ path?: string, prefix?: string, locked: boolean, dryRun?: boolean }} args
 */
export function lockWorkspaceDocs(bookRoot, args = {}) {
  return guarded(async () => {
    const { path: addr, prefix, locked, dryRun = false } = args ?? {};
    if (typeof locked !== 'boolean') return fail('REFUSED_BAD_ARGS', 'locked must be true or false');
    if ((addr === undefined) === (prefix === undefined)) return fail('REFUSED_BAD_ARGS', 'give exactly one of path and prefix');
    if (addr !== undefined) {
      const bad = checkAddress(addr);
      if (bad) return bad;
    } else if (typeof prefix !== 'string' || !STATE_FOLDER_RE.test(prefix)) return fail('REFUSED_BAD_ARGS', 'prefix must be a state chapter folder: state/chapter-NN');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    /** @type {string[]} */
    let addrs;
    if (addr !== undefined) addrs = [addr];
    else {
      const entries = await store.list(`planning/${prefix}`);
      addrs = entries.filter((e) => !e.isDirectory && STATE_FILE_RE.test(e.name)).map((e) => `${prefix}/${e.name.slice(0, -3)}`).sort();
    }
    const changes = [];
    const matched = [];
    const changed = [];
    for (const a of addrs) {
      const rel = workspacePath(a);
      const cur = await store.read(rel);
      if (!cur) continue;
      matched.push(a);
      if (isLockedBytes(cur.bytes) === locked) continue;
      const next = withLocked(cur.bytes, locked);
      if (!next) return fail('REFUSED_UNSIMPLE_FIELD', `${rel} has no closed front matter`, { field: 'locked' });
      changes.push({ from: rel, to: rel, content: next, before: cur.bytes });
      changed.push(a);
    }
    if (matched.length === 0) return fail('NOT_FOUND', addr !== undefined ? `no workspace doc ${addr}` : `no state docs under ${prefix}`);
    return finish({ bookRoot, store, lb, op: locked ? 'lockWorkspaceDocs' : 'unlockWorkspaceDocs', args: { ...(addr !== undefined ? { path: addr } : { prefix }), locked }, changes, dryRun, withDiff: false, extra: { locked, changed, matched } });
  });
}

/** Move a doc to archive/planning/ (never a delete), or back. A locked doc: LOCKED. @param {string} bookRoot @param {{ path: string, baseSha256?: string, dryRun?: boolean }} args @param {boolean} restoring */
function moveWorkspaceDoc(bookRoot, args, restoring) {
  return guarded(async () => {
    const { path: addr, baseSha256, dryRun = false } = args ?? {};
    const bad = checkAddress(addr);
    if (bad) return bad;
    if (baseSha256 !== undefined && typeof baseSha256 !== 'string') return fail('REFUSED_BAD_ARGS', 'base_sha256 must be a string');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const live = workspacePath(addr);
    const from = restoring ? `archive/${live}` : live;
    const to = restoring ? live : `archive/${live}`;
    const cur = await store.read(from);
    if (!cur) return fail('NOT_FOUND', `no ${restoring ? 'archived ' : ''}workspace doc ${addr}`);
    if (isLockedBytes(cur.bytes)) return lockedRefusal(addr);
    if (typeof baseSha256 === 'string' && sha256(cur.bytes) !== baseSha256) return conflict(addr, cur.bytes, `${from} changed on disk since it was read`);
    return finish({ bookRoot, store, lb, op: restoring ? 'restoreWorkspaceDoc' : 'archiveWorkspaceDoc', args: { path: addr }, changes: [{ from, to, content: cur.bytes, before: cur.bytes }], dryRun, withDiff: false, extra: { path: addr, file: to } });
  });
}

/** @param {string} bookRoot @param {{ path: string, baseSha256?: string, dryRun?: boolean }} args */
export const archiveWorkspaceDoc = (bookRoot, args = {}) => moveWorkspaceDoc(bookRoot, args, false);
/** @param {string} bookRoot @param {{ path: string, baseSha256?: string, dryRun?: boolean }} args */
export const restoreWorkspaceDoc = (bookRoot, args = {}) => moveWorkspaceDoc(bookRoot, args, true);

/**
 * Create the starter docs that do not exist yet (workspace/book, workspace/style and state/chapter-00/*) in one batch. A doc that exists, or whose address is archived, is left alone.
 * Result extra: { created: [address], existing: [address] }.
 * @param {string} bookRoot @param {{ dryRun?: boolean }} [args]
 */
export function setupWorkspace(bookRoot, args = {}) {
  return guarded(async () => {
    const { dryRun = false } = args ?? {};
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const changes = [];
    const created = [];
    const existing = [];
    for (const d of WORKSPACE_STARTERS) {
      const rel = workspacePath(d.path);
      if ((await store.exists(rel)) || (await store.exists(`archive/${rel}`))) {
        existing.push(d.path);
        continue;
      }
      changes.push({ from: null, to: rel, content: newDocText(d.path, d.title, d.body), before: null });
      created.push(d.path);
    }
    return finish({ bookRoot, store, lb, op: 'setupWorkspace', args: { created }, changes, dryRun, withDiff: false, extra: { created, existing } });
  });
}
