#!/usr/bin/env node
// sf-manuscript <command> <book> [options]
// Exit codes: 0 ok, 1 refused / rolled back / invalid book, 2 usage error.
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { validate } from '@storyforge/format';
import { applyRepair, insertScene, moveScene, planRepair, rebuildIndex, renumberChapter } from '../src/index.mjs';

const USAGE = `usage: sf-manuscript <command> <book> [options]
  order <book> [--json]
  index <book>
  repair <book> [--apply] [--json]
  insert <book> --chapter N --after <scene-id|start> --title T --slug S [--act N] [--status S]
         [--id scene_...] [--body TEXT | --body-file FILE] [--dry-run]
  move <book> <scene-id> --chapter N --after <scene-id|start> [--act N] [--dry-run]
  renumber <book> --chapter N [--step N] [--dry-run]`;

function usage(msg) {
  if (msg) process.stderr.write(`sf-manuscript: ${msg}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const options = {
  json: { type: 'boolean' },
  apply: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  chapter: { type: 'string' },
  act: { type: 'string' },
  after: { type: 'string' },
  title: { type: 'string' },
  slug: { type: 'string' },
  status: { type: 'string' },
  id: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  step: { type: 'string' },
};

let parsed;
try {
  parsed = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
} catch (e) {
  usage(e.message);
}
const { values: v, positionals } = parsed;
const [command, book, ...rest] = positionals;
if (!command || !book) usage();

try {
  if (!(await stat(book)).isDirectory()) throw new Error('not a directory');
} catch {
  usage(`not a directory: ${book}`);
}

const int = (name) => {
  if (v[name] === undefined) return undefined;
  if (!/^\d+$/.test(v[name])) usage(`--${name} must be a non-negative integer`);
  return Number(v[name]);
};
const needChapter = () => {
  const c = int('chapter');
  if (c === undefined) usage('--chapter is required');
  return c;
};
const anchor = () => {
  if (v.after === undefined) usage('--after is required (a scene id or "start")');
  return v.after === 'start' ? null : v.after;
};

function report(res) {
  if (v.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    process.stdout.write(`${res.code}${res.dryRun ? ' (dry run)' : ''}${res.message ? `: ${res.message}` : ''}\n`);
    for (const c of res.changes ?? []) process.stdout.write(`  ${c.from ?? '(new)'} -> ${c.to}\n`);
    for (const d of res.diagnostics ?? []) {
      if (d.severity === 'error') process.stdout.write(`  ${d.code} ${d.file} ${d.location} ${d.message}\n`);
    }
  }
  process.exitCode = res.ok ? 0 : 1;
}

switch (command) {
  case 'order': {
    if (rest.length) usage();
    const res = await validate(book);
    const b = res.books[0];
    if (!b || res.books.length !== 1) {
      process.stderr.write(`sf-manuscript: ${book} is not a single book root\n`);
      process.exit(1);
    }
    if (v.json) {
      process.stdout.write(`${JSON.stringify({ order: b.order, diagnostics: res.diagnostics }, null, 2)}\n`);
    } else {
      for (const s of b.order) {
        process.stdout.write([s.position, s.chapter_label, s.sequence, s.id, s.title, s.path].join('\t') + '\n');
      }
    }
    const bad = res.diagnostics.filter((d) => d.severity === 'error' && d.file.startsWith('manuscript/'));
    for (const d of bad) process.stderr.write(`${d.code} ${d.file} ${d.location} ${d.message}\n`);
    process.exitCode = bad.length ? 1 : 0;
    break;
  }
  case 'index': {
    if (rest.length) usage();
    const res = await rebuildIndex(book);
    process.stdout.write(`${res.code}${res.ok ? ` (${res.index.scenes.length} scenes)` : `: ${res.message}`}\n`);
    process.exitCode = res.ok ? 0 : 1;
    break;
  }
  case 'repair': {
    if (rest.length) usage();
    const plan = await planRepair(book);
    if (!plan.ok) {
      process.stderr.write(`sf-manuscript: ${plan.code}: ${plan.message}\n`);
      process.exit(1);
    }
    if (v.json && !v.apply) {
      process.stdout.write(`${JSON.stringify({ actions: plan.actions, unrepairable: plan.unrepairable }, null, 2)}\n`);
    } else if (!v.json) {
      for (const a of plan.actions) {
        process.stdout.write(a.kind === 'rename' ? `rename ${a.from} -> ${a.to}\n` : `renumber chapter ${a.chapter}\n`);
      }
      for (const d of plan.unrepairable) process.stdout.write(`unrepairable ${d.code} ${d.file} ${d.location}\n`);
      if (plan.actions.length === 0 && plan.unrepairable.length === 0) process.stdout.write('nothing to repair\n');
    }
    if (v.apply) {
      report(await applyRepair(book, plan.actions));
    } else {
      process.exitCode = plan.unrepairable.length ? 1 : 0;
    }
    break;
  }
  case 'insert': {
    if (rest.length) usage();
    if (!v.title && v.title !== '') usage('--title is required');
    if (!v.slug) usage('--slug is required');
    let body = v.body ?? '';
    if (v['body-file']) body = await readFile(v['body-file'], 'utf8');
    report(
      await insertScene(book, {
        chapter: needChapter(),
        act: int('act'),
        after: anchor(),
        title: v.title,
        slug: v.slug,
        body,
        status: v.status,
        id: v.id,
        dryRun: v['dry-run'] === true,
      }),
    );
    break;
  }
  case 'move': {
    if (rest.length !== 1) usage('move needs exactly one scene id');
    report(
      await moveScene(book, rest[0], { chapter: needChapter(), act: int('act'), after: anchor(), dryRun: v['dry-run'] === true }),
    );
    break;
  }
  case 'renumber': {
    if (rest.length) usage();
    report(await renumberChapter(book, needChapter(), { step: int('step'), dryRun: v['dry-run'] === true }));
    break;
  }
  default:
    usage(`unknown command: ${command}`);
}
