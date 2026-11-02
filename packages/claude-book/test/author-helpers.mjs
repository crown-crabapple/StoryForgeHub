// Helpers for the M05-J06 adapter tests (not a test file). Builds on helpers.mjs (temp framework, fixture copies, snapshots).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abs, cli, diffSnapshots, makeFramework, snapshot, tmp } from './helpers.mjs';

export const ARRIVAL = 'scene_01S50000000000000000000002';
export const KEY = 'scene_01S50000000000000000000003';
export const GRAFTING = 'scene_01S50000000000000000000006'; // the CRLF scene
export const ARRIVAL_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const GRAFTING_PATH = 'manuscript/act-01-low-water/ch-002-the-grafting/0020-the-grafting.md';
export const CF1 = 'cf1-e85d78f4354c4ffc';
export const WORK = '.work/salt-orchard';
export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NET_PRELOAD = path.resolve(HERE, '../../../apps/server/test/ai-net-preload.mjs');

/** Independent line oracle over the ORIGINAL text: replace single lines (1-based), everything else byte-identical. */
export function replaceLines(text, edits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  const ls = text.split(eol);
  if (trailing) ls.pop();
  for (const [line, t] of Object.entries(edits)) ls[Number(line) - 1] = t;
  return ls.join(eol) + (trailing ? eol : '');
}
/** The prose lines of Arrival in the fixture (file lines 15, 17, 19) after three edits. */
export const ARRIVAL_EDITS = {
  15: 'The ferry bumped the jetty and [[tobin-reyes|the ferryman]] flung her bag ashore.',
  17: 'In the glass of the ticket hut she caught her own face, grey eyes ringed with salt, and looked away.',
  19: 'Past the dunes lay [[salt-orchard]], half drowned.',
};

/** Text of the scene body (everything after the closing front matter line). */
export const bodyOf = (text) => text.slice(/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)[0].length);
export const frontOf = (text) => /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)[0];

/** A fresh book + framework pair, a `go(command, { chapter, extra })` runner and per-run write-set diffs for both trees. */
export function setup({ book, python = false } = {}) {
  const b = book ?? abs(tmp(), 'salt-orchard');
  if (!book) fs.cpSync(path.resolve(HERE, '../../format/fixtures/valid/salt-orchard'), b, { recursive: true });
  const fw = makeFramework();
  fs.mkdirSync(path.join(fw, 'analysis/.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'analysis/.claude/agents/chapter-planner.md'), '---\nname: chapter-planner\n---\nStub.\n');
  const go = (command, { chapter, extra = [], env } = {}) => {
    const bookBefore = snapshot(b);
    const fwBefore = snapshot(fw);
    const args = [command, '--book', b, '--framework', fw];
    if (chapter != null) args.push('--chapter', String(chapter));
    const r = cli([...args, ...extra], { env });
    const strip = (d) => ({ added: d.added.filter((p) => !p.startsWith('.storyforge')), removed: d.removed, changed: d.changed.filter((p) => !p.startsWith('.storyforge')) });
    return { r, bookD: strip(diffSnapshots(bookBefore, snapshot(b))), fwD: diffSnapshots(fwBefore, snapshot(fw)), status: r.status };
  };
  return { book: b, fw, go, python };
}

/** Write a file into a scratch dir (outside both trees) and return its path. */
export function scratch(name, content) {
  const f = path.join(tmp('sf-cb-in-'), name);
  fs.writeFileSync(f, content);
  return f;
}

/** Env that preloads the M05-J04 network recorder into the adapter process; read the calls with `netCalls(log)`. */
export function netEnv() {
  const log = path.join(tmp('sf-cb-net-'), 'net.jsonl');
  return { log, env: { NODE_OPTIONS: `--import ${pathToFileURL(NET_PRELOAD).href}`, SF_NET_LOG: log } };
}
export const netCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** All suggestion files in a book: [{ rel, text, fm }] with the front matter parsed by a tiny YAML read. */
export async function suggestionsIn(book) {
  const { default: YAML } = await import('yaml');
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const text = fs.readFileSync(full, 'utf8');
        out.push({ rel: path.relative(book, full).split(path.sep).join('/'), text, fm: YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1]) });
      }
    }
  };
  walk(path.join(book, 'suggestions'));
  return out;
}

/** A sample state-updater output (chapter-NN-ledgers.json) for salt-orchard chapter 1. */
export const LEDGERS = {
  chapter: '1',
  cast: [
    { slug: 'maren-hollis', role: 'pov' },
    { slug: 'tobin-reyes', role: 'appears' },
    { slug: 'the-ticket-hut', role: 'mentioned' },
  ],
  knowledge: [{ character: 'maren-hollis', knows: 'Tobin still works the ferry', learned_in: '1' }],
  state_events: [{ slug: 'maren-hollis', event: 'location', value: 'port-aldine' }],
  ledger_items: [
    { title: 'The glass of the ticket hut', kind: 'mystery', notes: 'Maren sees her own face and looks away.' },
    { slug: 'brass-key', payoff_in: '1', notes: 'sample payoff' },
  ],
  unknown_slugs: ['the-ticket-hut'],
};
