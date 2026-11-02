// Render @storyforge/continuity findings in the layout the Claude-Book orchestrator saves as
// context/continuity-check.md: a title, pass/errors/warnings bullets with evidence, dismissed findings.

/** @typedef {import('./model.mjs').Model} Model */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A finding touches chapter <= n when any of its sources sits in such a chapter, or none of them has a chapter.
 * @param {Model} model @param {any} finding @param {number} n
 */
function touches(model, finding, n) {
  const chapters = [];
  for (const s of finding.sources) {
    const d = model.docs.find((x) => x.file === s.file);
    if (!d) continue;
    if (d.kind === 'scene' && Number.isInteger(d.fm.chapter)) chapters.push(d.fm.chapter);
    else if (d.kind === 'event') {
      const c = model.narrativeChapter(d);
      if (c !== null) chapters.push(c);
    }
  }
  return chapters.length === 0 || chapters.some((c) => c <= n);
}

/**
 * @param {Model} model @param {number} n @param {import('@storyforge/continuity').ContinuityResult} result
 * @returns {string}
 */
export function renderContinuity(model, n, result) {
  const findings = result.findings.filter((f) => touches(model, f, n));
  const dismissed = result.suppressed.filter((s) => touches(model, s.finding, n));
  const by = (sev) => findings.filter((f) => f.severity === sev);
  const errors = by('error');

  const lines = [
    `# Continuity check - chapter ${pad2(n)} candidate`,
    '',
    `StoryForge continuity engine v${result.engine_version}, run by sf-claude-book over the book's canonical Markdown. Nothing saved.`,
    '',
    `- pass: ${errors.length === 0}`,
  ];
  const list = (label, items) => {
    lines.push(`- ${label}: ${items.length}${items.length > 0 ? ':' : ''}`);
    for (const f of items) {
      lines.push(`  - ${f.title} [${f.rule}, ${f.fingerprint}]`);
      for (const s of f.sources) lines.push(`    - ${s.file}:${s.line} (${s.role}) ${s.excerpt}`);
    }
  };
  list('errors', errors);
  list('warnings', by('warning'));
  list('info', by('info'));
  lines.push(`- dismissed: ${dismissed.length}${dismissed.length > 0 ? ':' : ''}`);
  for (const { finding, exception } of dismissed) {
    lines.push(`  - ${finding.title} [${finding.rule}, ${finding.fingerprint}]: suppressed, rationale in ${exception.file}`);
  }
  if (result.stale_exceptions.length > 0) {
    lines.push(`- stale exceptions: ${result.stale_exceptions.map((x) => x.file).join(', ')}`);
  }
  if (result.skipped.length > 0) lines.push(`- unreadable files skipped: ${result.skipped.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
