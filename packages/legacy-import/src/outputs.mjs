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
