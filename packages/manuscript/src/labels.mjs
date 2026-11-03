// Labels of a book or a series (M07-J01 section 3): the `labels:` list of book.md / series.md, [{ name, color }].
// Same rules as the other commands: one batch through the store, a dry run, refused when it would add a validation error, nothing is deleted.
// Only the `labels` block of the file changes; the rest of the front matter and the body stay byte for byte.
import { prepareCodex, replaceFrontMatterBlock } from './codex.mjs';
import { formatYamlText } from './frontmatter.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { sha256 } from './util.mjs';

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);

/** Lines of the `labels:` block. @param {{ name: string, color: string }[]} labels */
export function labelLines(labels) {
  if (labels.length === 0) return ['labels: []'];
  return ['labels:', ...labels.flatMap((l) => [`  - name: ${formatYamlText(l.name)}`, `    color: "${l.color.toUpperCase()}"`])];
}

/**
 * Replace the labels of book.md (`scope: 'book'`, `root` a book folder) or series.md (`scope: 'series'`, `root` a series folder).
 * Names are unique ignoring case; a colour is #RRGGBB. Documents that name a label that is no longer defined get W311 (a warning, never a refusal).
 * @param {string} root
 * @param {{ scope?: 'book' | 'series', labels: { name: string, color: string }[], dryRun?: boolean, baseSha256?: string }} args
 */
export function setLabels(root, args = {}) {
  return guarded(async () => {
    const { scope = 'book', labels, dryRun = false, baseSha256 } = args ?? {};
    if (scope !== 'book' && scope !== 'series') return fail('REFUSED_BAD_ARGS', "scope must be 'book' or 'series'");
    if (!Array.isArray(labels) || labels.length > 100) return fail('REFUSED_BAD_ARGS', 'labels must be a list of up to 100 { name, color }');
    const seen = new Set();
    const clean = [];
    for (const l of labels) {
      if (l === null || typeof l !== 'object' || Array.isArray(l) || typeof l.name !== 'string' || typeof l.color !== 'string') return fail('REFUSED_BAD_ARGS', 'each label needs a name and a colour');
      const name = l.name.trim();
      if (name === '' || name.length > 60 || CONTROL_RE.test(name)) return fail('REFUSED_BAD_ARGS', 'a label name is 1 to 60 characters without control characters');
      if (!COLOR_RE.test(l.color)) return fail('REFUSED_BAD_ARGS', `the colour of "${name}" must be written #RRGGBB`);
      if (seen.has(name.toLowerCase())) return fail('REFUSED_BAD_ARGS', `the label "${name}" is listed twice (names are compared ignoring case)`);
      seen.add(name.toLowerCase());
      clean.push({ name, color: l.color });
    }
    const prep = await prepareCodex(root, scope);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const rel = scope === 'series' ? 'series.md' : 'book.md';
    const before = await readBytes(store, rel);
    if (typeof baseSha256 === 'string') {
      if (sha256(before) !== baseSha256) return fail('CONFLICT', `${rel} changed on disk since it was read`, { file: rel });
    }
    const had = /^labels:/m.test(before.toString('latin1'));
    if (clean.length === 0 && !had) return finish({ bookRoot: root, store, lb, op: 'setLabels', args: { scope }, changes: [], dryRun, withDiff: true, extra: { path: rel, labels: clean } });
    const r = replaceFrontMatterBlock(before, 'labels', labelLines(clean), { after: ['status', 'series_number', 'title', 'slug', 'id'] });
    if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: 'labels' });
    const changes = r.buf.equals(before) ? [] : [{ from: rel, to: rel, content: r.buf, before }];
    return finish({ bookRoot: root, store, lb, op: 'setLabels', args: { scope, labels: clean.length }, changes, dryRun, withDiff: true, extra: { path: rel, labels: clean } });
  });
}
