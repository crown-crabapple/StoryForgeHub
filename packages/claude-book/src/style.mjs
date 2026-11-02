// Run Claude-Book's own style checker on a candidate and copy its report into the work folder (contract section 4).
// The checker writes <framework>/.work/chapter-NN-tech-report-<uuid8>.md itself; that file is read, never changed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { UsageError, listFiles, mtimeMs, readText } from './io.mjs';
import { pad2 } from './pack.mjs';

/**
 * @param {{ framework: string, python: string, candidatePath: string, chapter: number, min: number, max: number }} o
 * @returns {{ report: string, verdict: 'PASS'|'FAIL'|'UNKNOWN', verdictLine: string, stdout: string }} report = absolute path of the checker's own report
 */
export function runStyleChecker({ framework, python, candidatePath, chapter, min, max }) {
  const scriptDir = path.join(framework, 'scripts', 'style');
  const script = path.join(scriptDir, 'style_checker.py');
  const started = Date.now() - 1000;
  const run = spawnSync(python, [script, '--min-words', String(min), '--max-words', String(max), candidatePath], {
    cwd: scriptDir,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (run.error) {
    const missing = /** @type {any} */ (run.error).code === 'ENOENT';
    throw new UsageError(missing ? `Python not found: "${python}". Install Python 3.10+ or pass --python <exe>.` : `cannot run ${python}: ${run.error.message}`);
  }
  // The checker exits 0 (pass) or 1 (blocking errors); anything else is a crash.
  if (run.status !== 0 && run.status !== 1) {
    throw new UsageError(`style_checker.py exited with ${run.status}: ${(run.stderr || run.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  }
  const workRoot = path.join(framework, '.work');
  const prefix = `chapter-${pad2(chapter)}-tech-report-`;
  const fresh = listFiles(workRoot)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .map((f) => ({ f, t: mtimeMs(path.join(workRoot, f)) }))
    .filter((x) => x.t >= started)
    .sort((a, b) => b.t - a.t || (a.f < b.f ? 1 : -1));
  if (fresh.length === 0) throw new UsageError(`style_checker.py ran but wrote no ${prefix}*.md report under ${workRoot}`);
  const report = path.join(workRoot, fresh[0].f);

  const text = readText(report);
  const at = text.indexOf('## Verdict');
  const after = at < 0 ? '' : text.slice(at + '## Verdict'.length).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const verdict = /\bFAIL\b/.test(after) ? 'FAIL' : /\bPASS\b/.test(after) ? 'PASS' : 'UNKNOWN';
  return { report, verdict, verdictLine: after.replace(/\*\*/g, ''), stdout: run.stdout };
}
