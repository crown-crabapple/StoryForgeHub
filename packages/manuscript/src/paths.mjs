// Canonical scene paths (contract: act-<NN>-<slug>/ch-<NNN>-<slug>/<NNNN>-<slug>.md).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readSimpleLine } from './frontmatter.mjs';
import { pad, slugify } from './util.mjs';

const ACT_DIR_RE = /^act-(\d+)(?:-|$)/;
const CHAP_DIR_RE = /^ch-(\d+)(?:-|$)/;

async function subdirs(abs) {
  try {
    return (await readdir(abs, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Scene filename slug: the current filename minus its numeric prefix and `.md`. */
export function sceneSlugOf(relPath) {
  return path.posix.basename(relPath).replace(/\.md$/, '').replace(/^\d+-/, '');
}

export const sceneFileName = (sequence, slug) => `${pad(sequence, 4)}-${slug}.md`;

/**
 * Scan manuscript/ once and return a resolver for folder names.
 * @param {string} root book root (absolute)
 */
export async function makePathResolver(root) {
  const ms = path.join(root, 'manuscript');
  /** @type {Map<number,string>} titles from act.md / chapter.md, by number */
  const actTitles = new Map();
  const chapTitles = new Map();
  const actDirs = await subdirs(ms);
  /** @type {Map<string,string[]>} act dir name -> chapter dir names */
  const chapDirsByAct = new Map();

  async function readMeta(file, key, table) {
    let buf;
    try {
      buf = await readFile(file);
    } catch {
      return;
    }
    const n = readSimpleLine(buf, key);
    const title = readSimpleLine(buf, 'title');
    if (n !== null && /^\d+$/.test(n) && title !== null && !table.has(Number(n))) table.set(Number(n), title);
  }

  for (const a of actDirs) {
    const chaps = await subdirs(path.join(ms, a));
    chapDirsByAct.set(a, chaps);
    await readMeta(path.join(ms, a, 'act.md'), 'act', actTitles);
    for (const c of chaps) await readMeta(path.join(ms, a, c, 'chapter.md'), 'chapter', chapTitles);
  }

  const unique = (names, re, n) => {
    const hits = names.filter((x) => {
      const m = re.exec(x);
      return m && Number(m[1]) === n;
    });
    return hits.length === 1 ? hits[0] : null;
  };

  return {
    /** Folder (relative, forward slashes) for a scene with this act/chapter. */
    dir(act, chapter) {
      let actName = unique(actDirs, ACT_DIR_RE, act);
      if (!actName) {
        const s = slugify(actTitles.get(act) ?? '');
        actName = `act-${pad(act, 2)}${s ? `-${s}` : ''}`;
      }
      let chapName = unique(chapDirsByAct.get(actName) ?? [], CHAP_DIR_RE, chapter);
      if (!chapName) {
        const s = slugify(chapTitles.get(chapter) ?? '');
        chapName = `ch-${pad(chapter, 3)}${s ? `-${s}` : ''}`;
      }
      return `manuscript/${actName}/${chapName}`;
    },
    /** Full canonical path. */
    scenePath(act, chapter, sequence, slug) {
      return `${this.dir(act, chapter)}/${sceneFileName(sequence, slug)}`;
    },
  };
}
