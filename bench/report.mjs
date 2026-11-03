// The Markdown table of one benchmark run, appended to docs/performance.md (M08-J04 contract section 4). Pure formatting: no measuring here.
import fs from 'node:fs';
import { OPERATIONS } from './operations.mjs';

/** 842.5 -> "843 ms", 12345 -> "12.3 s", 190000 -> "3 min 10 s". @param {number | null | undefined} ms */
export function formatMs(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** @param {number} n */
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * The section for one run: a header with the machine, the fixture sizes, the operations table and a note for every operation that did not finish.
 * @param {any} result the JSON that run.mjs wrote @param {string} file the results file, relative to the repository
 */
export function renderRun(result, file) {
  const names = Object.keys(result.fixtures);
  const m = result.machine;
  const lines = [];
  lines.push(`### Run ${result.date}, machine ${m.hash}${result.git ? `, commit ${result.git}` : ''}`);
  lines.push('');
  lines.push(`Node ${m.node}, ${m.os}, ${m.cpu} (${m.cores} threads), ${m.ram_mb} MB RAM. Median of ${result.reps} runs; raw numbers in \`${file}\`.`);
  lines.push('');
  lines.push(`| Fixture | ${names.join(' | ')} |`);
  lines.push(`|---|${names.map(() => '---').join('|')}|`);
  const words = (n) => (n < 1000 ? `${n} words` : `${Math.round(n / 1000)}k words`);
  const size = (f) => `${f.size.scenes} scenes, ${words(f.size.words)}, ${f.size.books} book${f.size.books === 1 ? '' : 's'}, ${kb(f.size.bytes)}`;
  lines.push(`| Size | ${names.map((n) => size(result.fixtures[n])).join(' | ')} |`);
  const notes = [];
  for (const [key, label] of OPERATIONS) {
    const cells = names.map((n) => {
      const o = result.fixtures[n].operations[key];
      if (!o) return '-';
      if (o.status === 'ok') return formatMs(o.median_ms);
      notes.push(`${n}, ${label}: ${o.status === 'error' ? `failed: ${o.note}` : o.status === 'not_run' ? 'not run (time budget used up)' : `only ${o.runs_ms.length} of ${result.reps} runs finished (time budget used up); median of those: ${formatMs(o.median_ms)}`}`);
      return o.status === 'error' ? 'failed' : o.status === 'not_run' ? 'not run' : `${formatMs(o.median_ms)} (${o.runs_ms.length} runs)`;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  lines.push(`| Whole fixture (generation excluded) | ${names.map((n) => formatMs(result.fixtures[n].total_ms)).join(' | ')} |`);
  if (notes.length > 0) {
    lines.push('');
    for (const n of notes) lines.push(`- ${n}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Append a run to the document (created with a short header when it does not exist). @param {string} docPath @param {any} result @param {string} file */
export function appendRun(docPath, result, file) {
  const existing = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '# Performance\n\n## Results\n\n';
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(docPath, `${existing}${sep}${renderRun(result, file)}`);
}
