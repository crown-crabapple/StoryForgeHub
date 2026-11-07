// Plugin manifests (M08-J02): `<library>/_plugins/<id>/plugin.md`. A manifest describes what a separate plugin program will ask for; it grants nothing.
// StoryForge never runs plugin code. Parsing is pure; loadPlugins reads the folder (read-only). `_plugins/` is not a book: the scanner skips it.
import path from 'node:path';
import { isDirectory, isFile, listDirs, readText } from './fs.mjs';
import { isValidId, isValidSlug } from './ids.mjs';
import { parseText } from './frontmatter.mjs';

export const PLUGIN_SCHEMA = 'storyforge.plugin/v1';
/** What a plugin may ask for (the permissions of an access token). */
export const PLUGIN_PERMISSIONS = Object.freeze(['read', 'propose', 'events', 'canvas', 'plan']);
/** The API major version this StoryForge serves under /api/v1. A manifest that targets a larger one gets W315. */
export const PLUGIN_API_MAJOR = 1;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse and check one manifest's text.
 * @param {string} text the file as read
 * @returns {{ ok: boolean, item: any, problems: { code: string, location: string, message: string }[] }}
 */
export function parsePluginManifest(text) {
  /** @type {{ code: string, location: string, message: string }[]} */
  const problems = [];
  const bad = (location, message, code = 'E102') => problems.push({ code, location, message });
  const parsed = parseText(text);
  if (parsed.status === 'error') return { ok: false, item: null, problems: [{ code: parsed.error.code, location: '', message: parsed.error.message }] };
  const fm = parsed.fm ?? {};
  if (fm.schema !== PLUGIN_SCHEMA) bad('schema', `schema must be ${PLUGIN_SCHEMA}`);
  if (!isValidId(fm.id, 'note')) bad('id', 'id must be note_ followed by a 26-character ULID');
  if (!isValidSlug(fm.plugin)) bad('plugin', 'plugin must be a valid slug (a-z, 0-9, single hyphens)');
  if (typeof fm.name !== 'string' || fm.name.trim() === '') bad('name', 'name must be a non-empty string');
  if (typeof fm.version !== 'string' || !SEMVER_RE.test(fm.version)) bad('version', 'version must be a semantic version such as 1.2.0');
  if (!Number.isInteger(fm.api) || fm.api < 1) bad('api', 'api must be a whole number, 1 or more (the API major version the plugin targets)');
  let permissions = [];
  if (!Array.isArray(fm.permissions) || fm.permissions.length === 0) bad('permissions', `permissions must be a non-empty list of: ${PLUGIN_PERMISSIONS.join(', ')}`);
  else {
    fm.permissions.forEach((p, i) => {
      if (!PLUGIN_PERMISSIONS.includes(p)) bad(`permissions[${i}]`, `unknown permission ${JSON.stringify(p)} (permissions: ${PLUGIN_PERMISSIONS.join(', ')})`);
    });
    permissions = fm.permissions.filter((p) => PLUGIN_PERMISSIONS.includes(p));
  }
  /** @type {'all' | string[]} */
  let books = 'all';
  if (fm.books === 'all') books = 'all';
  else if (Array.isArray(fm.books) && fm.books.length > 0) {
    fm.books.forEach((b, i) => {
      if (!isValidSlug(b)) bad(`books[${i}]`, 'a book must be named by its slug');
    });
    books = fm.books.filter((b) => isValidSlug(b));
  } else bad('books', 'books must be "all" or a non-empty list of book slugs');
  if (fm.homepage !== undefined && typeof fm.homepage !== 'string') bad('homepage', 'homepage must be a string');
  if (Number.isInteger(fm.api) && fm.api > PLUGIN_API_MAJOR) problems.push({ code: 'W315', location: 'api', message: `this plugin needs API ${fm.api}; this StoryForge serves API ${PLUGIN_API_MAJOR} (needs a newer StoryForge)` });
  const item = {
    schema: PLUGIN_SCHEMA,
    id: typeof fm.id === 'string' ? fm.id : null,
    plugin: typeof fm.plugin === 'string' ? fm.plugin : null,
    name: typeof fm.name === 'string' ? fm.name : null,
    version: typeof fm.version === 'string' ? fm.version : null,
    api: Number.isInteger(fm.api) ? fm.api : null,
    permissions,
    books,
    homepage: typeof fm.homepage === 'string' ? fm.homepage : '',
    description: parsed.body.trim(),
  };
  return { ok: !problems.some((p) => p.code[0] === 'E'), item, problems };
}

/**
 * Read `<library>/_plugins/`: every manifest with its problems (never an exception). `diagnostics` are shaped like the validator's, `file` library-relative.
 * @param {string} libraryRoot absolute
 * @returns {Promise<{ plugins: any[], diagnostics: { code: string, file: string, location: string, message: string }[] }>}
 */
export async function loadPlugins(libraryRoot) {
  const dir = path.join(libraryRoot, '_plugins');
  /** @type {{ code: string, file: string, location: string, message: string }[]} */
  const diagnostics = [];
  /** @type {any[]} */
  const plugins = [];
  if (!(await isDirectory(dir))) return { plugins, diagnostics };
  /** @type {Map<string, string>} */
  const slugs = new Map();
  for (const name of await listDirs(dir)) {
    const rel = `_plugins/${name}/plugin.md`;
    const abs = path.join(dir, name, 'plugin.md');
    if (!(await isFile(abs))) {
      diagnostics.push({ code: 'E102', file: rel, location: '', message: 'a plugin folder needs a plugin.md' });
      continue;
    }
    const r = parsePluginManifest(await readText(abs));
    const mine = r.problems.map((p) => ({ ...p }));
    if (r.item?.plugin && slugs.has(r.item.plugin)) mine.push({ code: 'E102', location: 'plugin', message: `plugin ${r.item.plugin} is also named by ${slugs.get(r.item.plugin)}` });
    else if (r.item?.plugin) slugs.set(r.item.plugin, rel);
    for (const p of mine) diagnostics.push({ code: p.code, file: rel, location: p.location, message: p.message });
    if (r.item) plugins.push({ ...r.item, path: rel, folder: name, problems: mine });
  }
  return { plugins, diagnostics };
}

/**
 * The validator's hook for a library root: the shape of every manifest in `_plugins/` (E102, W315).
 * @param {string} libraryRoot @param {(code: string, file: string, loc: string, msg: string) => void} add
 */
export async function checkPlugins(libraryRoot, add) {
  for (const d of (await loadPlugins(libraryRoot)).diagnostics) add(d.code, d.file, d.location, d.message);
}
