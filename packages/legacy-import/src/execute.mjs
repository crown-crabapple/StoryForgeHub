// executePlan: write a plan into a NEW library folder, only through @storyforge/store (writeNewTree), all books in one call so the folder
// appears whole or not at all (M06-J02). compareLibraries: are two libraries byte-identical (apart from .storyforge/)? Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { writeNewTree } from '@storyforge/store';
import { byCodePoint } from './util.mjs';

/**
 * @param {{ books: { files: { path: string, bytes: Buffer }[] }[] }} plan
 * @param {string} intoDir a folder that does not exist or is empty
 * @returns {Promise<{ ok: boolean, files: number, code?: string }>}
 */
export async function executePlan(plan, intoDir) {
  const r = await writeNewTree(intoDir, function* produce() {
    for (const b of plan.books) for (const f of b.files) yield [f.path, f.bytes];
  });
  return r.ok ? { ok: true, files: r.files } : { ok: false, files: 0, code: r.code };
}

/** Every file below `dir` as relative posix path -> absolute path, skipping any `.storyforge` folder. */
function listFiles(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.storyforge') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.set(r, path.join(d, e.name));
    }
  };
  walk(path.resolve(dir), '');
  return out;
}

/**
 * @param {string} a library folder @param {string} b library folder
 * @returns {{ equivalent: boolean, differences: { path: string, why: string }[] }}
 */
export function compareLibraries(a, b) {
  const fa = listFiles(a);
  const fb = listFiles(b);
  const differences = [];
  for (const p of [...new Set([...fa.keys(), ...fb.keys()])].sort(byCodePoint)) {
    if (!fb.has(p)) differences.push({ path: p, why: 'only in the first library' });
    else if (!fa.has(p)) differences.push({ path: p, why: 'only in the second library' });
    else if (!fs.readFileSync(fa.get(p)).equals(fs.readFileSync(fb.get(p)))) differences.push({ path: p, why: 'the files differ' });
  }
  return { equivalent: differences.length === 0, differences };
}
