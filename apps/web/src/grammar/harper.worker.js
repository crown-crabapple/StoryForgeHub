// Harper grammar worker (M13-J02 §4). Owns one LocalLinter; the WASM is the same-origin asset behind harper.js/slimBinary.
// Messages in: configure { dialect, words, rules }, check { requestId, sceneId, body }, dispose.
// Messages out: ready, result { requestId, findings }, unsupported { requestId, reason }, error { requestId, message }.
import { LocalLinter, Dialect } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';
import { projectProse } from '../findings/prose-map.js';
import { toFindings } from './harper-adapter.js';

const DIALECTS = { american: Dialect.American, british: Dialect.British, australian: Dialect.Australian, canadian: Dialect.Canadian, indian: Dialect.Indian };
const NOT_ENGLISH = 'This scene does not look like English. Grammar checks support English only.';

/** @type {LocalLinter | null} */
let linter = null;
let queue = Promise.resolve();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Plain data from Harper's lints; every Lint and Suggestion is freed. */
function extract(organizedLints) {
  const out = {};
  for (const [rule, lints] of Object.entries(organizedLints)) {
    out[rule] = [];
    for (const lint of lints) {
      const suggestions = [];
      for (const s of lint.suggestions()) {
        const kind = ['Replace', 'Remove', 'InsertAfter'][s.kind()];
        if (kind) suggestions.push({ kind, text: s.get_replacement_text() });
        s.free();
      }
      const span = lint.span();
      out[rule].push({ start: span.start, end: span.end, kind: lint.lint_kind(), message: lint.message(), problem: lint.get_problem_text(), suggestions });
      lint.free();
    }
  }
  return out;
}

async function configure({ dialect, words, rules }) {
  const d = DIALECTS[dialect] ?? Dialect.American;
  if (!linter) {
    linter = new LocalLinter({ binary: slimBinary, dialect: d });
    await linter.setup();
  } else {
    await linter.setDialect(d);
  }
  const config = await linter.getDefaultLintConfig();
  const merged = {};
  for (const name of Object.keys(config)) merged[name] = null;
  for (const [name, value] of Object.entries(rules ?? {})) if (value === false) merged[name] = false;
  await linter.setLintConfig(merged);
  await linter.clearWords();
  if (Array.isArray(words) && words.length > 0) await linter.importWords(words);
  postMessage({ type: 'ready' });
}

async function check({ requestId, sceneId, body }) {
  if (!linter) throw new Error('The grammar checker has not been configured.');
  const projection = projectProse(body);
  if (projection.text.length >= 200 && !(await linter.isLikelyEnglish(projection.text))) {
    postMessage({ type: 'unsupported', requestId, reason: NOT_ENGLISH });
    return;
  }
  const organized = extract(await linter.organizedLints(projection.text, { language: 'plaintext' }));
  const sha256 = await sha256Hex(body);
  postMessage({ type: 'result', requestId, findings: toFindings({ sceneId, body, projection, sha256, organized }) });
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'dispose') {
    queue = queue.then(async () => {
      if (linter) await linter.dispose();
      linter = null;
      self.close();
    });
    return;
  }
  // One message at a time, in order, so a check never overlaps a configure.
  queue = queue.then(async () => {
    try {
      if (msg.type === 'configure') await configure(msg);
      else if (msg.type === 'check') await check(msg);
    } catch (err) {
      postMessage({ type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
    }
  });
};
