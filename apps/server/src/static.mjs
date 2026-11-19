// Static file serving for the built web app. This is the only server module allowed to touch
// the filesystem (see eslint.config.mjs). Reads only; never leaves the web root.
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** @param {string} file @returns {Promise<boolean>} */
async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} webRoot
 * @param {string} pathname raw (percent-encoded) URL path
 * @returns {Promise<{ status: number, type: string, body: Buffer | string }>}
 */
export async function serveStatic(webRoot, pathname) {
  const notFound = { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return notFound;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) return notFound;

  const root = path.resolve(webRoot);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return notFound;

  let file = target;
  if (!(await isFile(file))) {
    // Paths that look like files (have an extension) are real 404s; the rest are app routes.
    if (path.extname(decoded) !== '') return notFound;
    file = path.join(root, 'index.html');
    if (!(await isFile(file))) return notFound;
  }
  const type = /** @type {Record<string, string>} */ (TYPES)[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return { status: 200, type, body: await readFile(file) };
}

// ---- M13-J05: the Book interior preview's own assets, served under /interior-assets/<name> from a fixed allow-list. A request name is only ever looked up in the table below
// (never joined to a path), so an unlisted name, `..`, an encoded slash or an absolute path simply finds nothing.
const require = createRequire(import.meta.url);
const INTERIOR_PREFIX = '/interior-assets/';
/** The woff2 files the interior stylesheet names (latin and latin-ext, wght, normal and italic), used when @storyforge/export does not list them. */
const FALLBACK_FONT_FILES = ['literata', 'inter'].flatMap((font) => ['latin', 'latin-ext'].flatMap((subset) => ['normal', 'italic'].map((style) => `${font}-${subset}-wght-${style}.woff2`)));
const FONT_PACKAGES = { literata: '@fontsource-variable/literata', inter: '@fontsource-variable/inter' };

/** The folder of an installed package, found from a file the package exports (its package.json is not always exported). @param {string} specifier a resolvable file of the package @param {string} name */
function packageRoot(specifier, name) {
  const resolved = require.resolve(specifier);
  const marker = path.join('node_modules', ...name.split('/'));
  const at = resolved.lastIndexOf(marker);
  if (at < 0) throw new Error(`cannot locate the ${name} package`);
  return resolved.slice(0, at + marker.length);
}

/**
 * The allow-list: name -> { file, type }. Fixed when the module is built from the installed packages; the request never takes part in building a path.
 * @param {string[]} fontFiles file names of the Literata and Inter woff2 files
 * @returns {Map<string, { file: string, type: string }>}
 */
export function interiorAssetTable(fontFiles = FALLBACK_FONT_FILES) {
  /** @type {Map<string, { file: string, type: string }>} */
  const table = new Map();
  table.set('paged.js', { file: path.join(packageRoot('pagedjs', 'pagedjs'), 'dist', 'paged.js'), type: TYPES['.js'] });
  table.set('interior-boot.js', { file: fileURLToPath(new URL('../assets/interior/interior-boot.js', import.meta.url)), type: TYPES['.js'] });
  for (const name of fontFiles) {
    const font = Object.keys(FONT_PACKAGES).find((f) => name.startsWith(`${f}-`));
    if (font === undefined || !/^[a-z0-9-]+\.woff2$/.test(name)) continue;
    const pkg = /** @type {Record<string, string>} */ (FONT_PACKAGES)[font];
    table.set(name, { file: path.join(packageRoot(`${pkg}/wght.css`, pkg), 'files', name), type: TYPES['.woff2'] });
  }
  return table;
}

let interiorTable = null;
const interiorHeaders = (type) => ({ 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });

/**
 * GET /interior-assets/<name>: one of the allow-listed files, else 404.
 * @param {string} pathname raw (percent-encoded) URL path, starting with /interior-assets/
 * @param {{ table?: Map<string, { file: string, type: string }> }} [options] `table` is for tests
 * @returns {Promise<{ status: number, type: string, body: Buffer | string, headers: Record<string, string> }>}
 */
export async function serveInteriorAsset(pathname, options = {}) {
  const missing = { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found', headers: { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } };
  if (!pathname.startsWith(INTERIOR_PREFIX)) return missing;
  let name;
  try {
    name = decodeURIComponent(pathname.slice(INTERIOR_PREFIX.length));
  } catch {
    return missing;
  }
  if (!options.table) interiorTable ??= interiorAssetTable(await interiorFontFiles());
  const entry = (options.table ?? interiorTable)?.get(name);
  if (!entry) return missing;
  try {
    return { status: 200, type: entry.type, body: await readFile(entry.file), headers: interiorHeaders(entry.type) };
  } catch {
    return missing;
  }
}

/** The font file names @storyforge/export lists (or the fallback list when this build of it does not list them). */
async function interiorFontFiles() {
  const pkg = /** @type {any} */ (await import('@storyforge/export'));
  return Array.isArray(pkg.INTERIOR_FONT_FILES) ? pkg.INTERIOR_FONT_FILES : FALLBACK_FONT_FILES;
}

/**
 * The text of the fontsource wght.css and wght-italic.css of each interior font, read once by the caller. Pass each value to parseUnicodeRanges of @storyforge/export with
 * { files: INTERIOR_FONT_FILES } so only the subsets that are served count. A font whose files cannot be read is left out.
 * @returns {Promise<Record<string, string>>} font id -> CSS text
 */
export async function readInteriorCoverageCss() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [font, pkg] of Object.entries(FONT_PACKAGES)) {
    const parts = [];
    for (const file of ['wght.css', 'wght-italic.css']) {
      try {
        parts.push(await readFile(require.resolve(`${pkg}/${file}`), 'utf8'));
      } catch {
        /* the file is not there: this font has no coverage data */
      }
    }
    if (parts.length > 0) out[font] = parts.join('\n');
  }
  return out;
}
