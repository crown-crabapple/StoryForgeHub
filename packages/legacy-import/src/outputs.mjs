// Checks for the files the dry-run CLI may write (a report, a JSON plan): read-only path inspection; the write itself goes through @storyforge/store.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dumpDir @param {string} outPath
 * @returns {string | null} why the path must be refused, or null when it is fine
 */
export function outputPathProblem(dumpDir, outPath) {
  const out = path.resolve(outPath);
  if (fs.existsSync(out) || isLink(out)) return `${out} already exists; StoryForge never replaces it`;
  let realDir;
  try {
    realDir = fs.realpathSync(path.dirname(out));
  } catch {
    return `the folder for ${out} does not exist`;
  }
  let realDump;
  try {
    realDump = fs.realpathSync(path.resolve(dumpDir));
  } catch {
    return null; // the dump itself cannot be opened; the planner reports that
  }
  const rel = path.relative(realDump, path.join(realDir, path.basename(out)));
  if (!(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) return `${out} is inside the dump folder; the dump is never changed`;
  return null;
}

function isLink(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const LEGACY_REPO_NAME = 'legacy-StoryForgeHub';

/** The real path of the nearest existing ancestor of `p`, with the missing tail appended (so a folder that does not exist yet can be compared). */
function realish(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
};

/** @param {string} p @returns {boolean} true when `p` is an existing folder */
export function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} outPath @param {string} libraryDir @returns {boolean} true when a report path lies inside the library folder */
export function insideLibrary(outPath, libraryDir) {
  return isInside(realish(outPath), realish(libraryDir));
}

/**
 * Why `--into` must be refused (read-only inspection), or null when the folder is fine.
 * @param {string} dumpDir @param {string} into
 * @returns {string | null}
 */
export function intoPathProblem(dumpDir, into) {
  const target = realish(into);
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    // does not exist yet: fine
  }
  if (stat && !stat.isDirectory()) return `${into} is a file; the import needs a new folder`;
  if (stat && fs.readdirSync(target).length > 0) return `${into} already exists and is not empty; StoryForge never imports into an existing library`;
  if (isInside(target, realish(dumpDir))) return `${into} is inside the dump folder; the dump is never changed`;
  for (let d = target; ; d = path.dirname(d)) {
    if (path.basename(d).toLowerCase() === LEGACY_REPO_NAME.toLowerCase()) return `${into} is inside a ${LEGACY_REPO_NAME} folder; the legacy app is never changed`;
    if (path.dirname(d) === d) break;
  }
  return null;
}
