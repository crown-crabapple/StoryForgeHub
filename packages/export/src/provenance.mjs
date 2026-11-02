// Provenance in exports (M05-J07 section 5): the "Provenance summary" appendix and the private evidence package.
// Reads the receipt files of a book folder directly (read-only); never writes into the book. Receipts are records: nothing here
// decides who wrote or owns any text.
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadDoc } from '@storyforge/format';
import { writeZip } from './zip.mjs';

export const INCLUDE_MODES = Object.freeze(['manuscript', 'summary', 'evidence']);

export const NOT_LEGAL_ADVICE = 'Receipts are a record of what happened in this project. They are not legal advice and do not decide who owns or can copyright any text.';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const noop = () => {};

/**
 * @typedef {{ rel: string, id: string, at: string, fm: Record<string, any>, body: string, bytes: Buffer }} ReceiptFile
 */

/** @param {string} dir @param {string} rel @param {string[]} out */
async function walk(dir, rel, out) {
  let entries;
  try {
    entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (child !== 'objects') await walk(dir, child, out);
    } else if (e.isFile() && /^rcpt_[^/]+\.md$/.test(e.name)) {
      out.push(child);
    }
  }
}

/**
 * Every readable receipt of the book, oldest first (by `at`, then id). Files that do not parse are left out (the integrity check reports them).
 * @param {string} bookRoot @returns {Promise<ReceiptFile[]>}
 */
export async function readReceipts(bookRoot) {
  const base = path.join(path.resolve(bookRoot), 'provenance');
  /** @type {string[]} */
  const names = [];
  await walk(base, '', names);
  /** @type {ReceiptFile[]} */
  const out = [];
  for (const name of names.sort()) {
    const abs = path.join(base, ...name.split('/'));
    const { doc } = await loadDoc(abs, name, name, noop);
    if (!doc || typeof doc.fm.id !== 'string') continue;
    out.push({ rel: `provenance/${name}`, id: doc.fm.id, at: String(doc.fm.at ?? ''), fm: doc.fm, body: doc.body, bytes: await readFile(abs) });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const lines = (r) => (Array.isArray(r.fm.ranges) && r.fm.ranges.length > 0 ? r.fm.ranges.map((x) => `${x.after?.[0]}-${x.after?.[1]}`).join(', ') : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The plain-language lineage of one scene's receipts (oldest first): runs of author saves become "Author edited (N sessions)".
 * @param {ReceiptFile[]} receipts @returns {string[]}
 */
export function lineageSteps(receipts) {
  /** @type {string[]} */
  const steps = [];
  let edits = 0;
  const flushEdits = () => {
    if (edits > 0) steps.push(edits === 1 ? 'Author edited' : `Author edited (${edits} sessions)`);
    edits = 0;
  };
  for (const r of receipts) {
    const op = r.fm.operation;
    if (op === 'author.edit') {
      edits += 1;
      continue;
    }
    flushEdits();
    const ai = r.fm.ai ?? {};
    const hunks = Array.isArray(ai.hunks) ? ai.hunks.length : 1;
    const who = [ai.provider, ai.model, ai.locality].filter((x) => typeof x === 'string' && x !== '').join(', ');
    const at = lines(r);
    if (op === 'baseline') steps.push('Author wrote (baseline)');
    else if (op === 'external.change') steps.push('Changed outside StoryForge');
    else if (op === 'ai.proposal') steps.push(`AI suggested ${plural(hunks, 'change', 'changes')}${who ? ` (${who})` : ''}`);
    else if (op === 'ai.generation') steps.push(`AI drafted text${who ? ` (${who})` : ''}`);
    else if (op === 'suggestion.accept') steps.push(at ? `Author accepted lines ${at}` : 'Author accepted a change');
    else if (op === 'suggestion.decline') steps.push(`Author declined ${plural(hunks, 'change', 'changes')}`);
    else if (op === 'undo') steps.push('Author undid a change');
    else if (op === 'revision.restore') steps.push('Author restored an earlier revision');
    else if (op === 'publish') steps.push('Author published a draft into the scene');
    else if (op === 'check.report') steps.push('A check report was recorded');
    else steps.push(String(op ?? 'Recorded'));
  }
  flushEdits();
  return steps;
}

/** @param {ReceiptFile[]} receipts @param {string} sceneId */
const forScene = (receipts, sceneId) => receipts.filter((r) => r.fm.target?.id === sceneId);

/**
 * Append the "Provenance summary" chapter to an assembled manuscript (in place). Per included scene: the lineage in words, counts and receipt
 * ids, then the not-legal-advice note. No prompts, no provider settings beyond provider/model/locality in the lineage, no content hashes.
 * @param {import('./manuscript.mjs').Manuscript} manuscript @param {string} bookRoot
 */
export async function appendProvenanceSummary(manuscript, bookRoot) {
  const receipts = await readReceipts(bookRoot);
  const paras = ['This appendix lists, for each scene, what the project receipts record about how its text came to be. It is a summary of records, not a finding about any text.'];
  for (const part of manuscript.parts) {
    for (const chapter of part.chapters) {
      for (const scene of chapter.scenes) {
        const mine = forScene(receipts, scene.id);
        const title = scene.title !== '' ? scene.title : 'Untitled scene';
        if (mine.length === 0) {
          paras.push(`${title}: no receipts recorded.`);
          continue;
        }
        const ai = mine.filter((r) => r.fm.actor === 'ai' || r.fm.ai).length;
        paras.push(`${title}: ${plural(mine.length, 'receipt', 'receipts')}, ${ai} involving AI. ${lineageSteps(mine).join(' > ')}. Receipt ids: ${mine.map((r) => r.id).join(', ')}.`);
      }
    }
  }
  paras.push(NOT_LEGAL_ADVICE);
  manuscript.parts.push({ label: 'Appendix', chapters: [{ label: 'Provenance summary', title: '', scenes: [{ id: 'provenance-summary', title: '', markdown: paras.join('\n\n') }] }] });
}

/** The receipts and objects checked on their own, when the caller has no fuller result. @param {string} bookRoot @param {ReceiptFile[]} receipts */
async function basicVerify(bookRoot, receipts) {
  /** @type {{ code: string, file: string, receipt?: string, detail: string }[]} */
  const problems = [];
  const byId = new Map(receipts.map((r) => [r.id, r]));
  for (const r of receipts) {
    for (const p of Array.isArray(r.fm.parents) ? r.fm.parents : []) {
      const parent = byId.get(p?.id);
      if (!parent) problems.push({ code: 'RCPT_PARENT_MISSING', file: r.rel, receipt: r.id, detail: `parent ${p?.id} has no receipt file` });
      else if (sha256(parent.bytes) !== p.sha256) problems.push({ code: 'RCPT_PARENT_ALTERED', file: r.rel, receipt: r.id, detail: `parent ${p.id} no longer matches the recorded hash` });
    }
    for (const h of [r.fm.before_sha256, r.fm.after_sha256]) {
      if (typeof h !== 'string' || h === '') continue;
      const rel = `provenance/objects/${h.slice(0, 2)}/${h}`;
      let bytes = null;
      try {
        bytes = await readFile(path.join(bookRoot, ...rel.split('/')));
      } catch {
        problems.push({ code: 'RCPT_OBJECT_MISSING', file: rel, receipt: r.id, detail: 'the object this receipt names is absent' });
      }
      if (bytes && sha256(bytes) !== h) problems.push({ code: 'RCPT_OBJECT_ALTERED', file: rel, receipt: r.id, detail: 'the object bytes do not hash to its name' });
    }
  }
  return { ok: problems.length === 0, receipts: receipts.length, problems };
}

/**
 * The private evidence package: a zip of the manuscript export, the receipts of the selected scenes with the objects they name, verify.json and README.txt.
 * @param {{ bookRoot: string, manuscript: import('./manuscript.mjs').Manuscript, manuscriptFile: { bytes: Buffer, filename: string }, sceneIds?: string[], verify?: any }} p
 * @returns {Promise<{ bytes: Buffer, files: string[] }>}
 */
export async function buildEvidencePackage({ bookRoot, manuscript, manuscriptFile, sceneIds, verify }) {
  const root = path.resolve(bookRoot);
  const all = await readReceipts(root);
  const included = manuscript.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
  const selected = new Set(sceneIds ?? included);
  const chosen = all.filter((r) => selected.has(r.fm.target?.id));
  /** @type {{ name: string, data: Buffer }[]} */
  const entries = [{ name: `manuscript/${manuscriptFile.filename}`, data: manuscriptFile.bytes }];
  for (const r of chosen) entries.push({ name: r.rel, data: r.bytes });
  const hashes = new Set(chosen.flatMap((r) => [r.fm.before_sha256, r.fm.after_sha256]).filter((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));
  for (const h of [...hashes].sort()) {
    const rel = `provenance/objects/${h.slice(0, 2)}/${h}`;
    try {
      entries.push({ name: rel, data: await readFile(path.join(root, ...rel.split('/'))) });
    } catch {
      // a missing object is reported by verify.json, never invented
    }
  }
  const result = verify ?? (await basicVerify(root, all));
  entries.push({ name: 'verify.json', data: Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8') });
  const readme = [
    `Evidence package for "${manuscript.title}"`,
    '',
    'What this is: a private record of how the text of this book came to be, made by StoryForge from the files in the book folder.',
    'It holds the manuscript export, the provenance receipts of the selected scenes with the content objects they name (so every saved state can be read back),',
    'and verify.json, the result of checking the receipts hash chain when this package was made. Nothing in it was changed or repaired.',
    '',
    'It is private. It contains your full text history and any prompts you chose to keep. Share it only with people you trust.',
    '',
    NOT_LEGAL_ADVICE,
    '',
    'Contents:',
    '  manuscript/        the manuscript export',
    '  provenance/        receipts (Markdown) and provenance/objects (raw saved states, no extension)',
    '  verify.json        integrity check result',
    '  README.txt         this file',
    '',
  ].join('\n');
  entries.push({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
  return { bytes: writeZip(entries), files: entries.map((e) => e.name) };
}
