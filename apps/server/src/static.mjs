// Static file serving for the built web app. This is the only server module allowed to touch
// the filesystem (see eslint.config.mjs). Reads only; never leaves the web root.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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
