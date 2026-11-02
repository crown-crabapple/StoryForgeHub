// The owner-readable reconciliation report (Markdown) and its JSON form. Only ids, paths, slugs, counts and hashes: never manuscript or entry text.
const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');

/** @param {{ dump: { sha256: string }, library: string, books: any[], unexplained: number }} rec */
export function renderReconciliation(rec) {
  const out = [];
  out.push('# Import reconciliation', '');
  out.push(`Dump manifest sha256: \`${rec.dump.sha256}\``, '');
  out.push(`Result: ${rec.unexplained === 0 ? 'every check passed (no unexplained difference)' : `${rec.unexplained} check(s) failed (unexplained differences)`}.`, '');
  for (const b of rec.books) {
    out.push(`## Book ${b.slug} (legacy id ${b.legacy_id})`, '');
    out.push('| Check | Legacy | v2 | Result |', '|---|---|---|---|');
    for (const c of b.checks) out.push(`| ${cell(c.name)} | ${cell(c.legacy)} | ${cell(c.v2)} | ${c.ok ? 'ok' : 'FAILED'} |`);
    out.push('');
    const counts = b.checks.find((c) => c.name === 'counts');
    if (counts?.rows?.length) {
      out.push('Counts in detail:', '', '| Item | Legacy | v2 |', '|---|---|---|');
      for (const r of counts.rows) out.push(`| ${cell(r.item)} | ${r.legacy} | ${r.v2} |`);
      out.push('');
    }
    const explained = b.checks.filter((c) => c.explained);
    out.push('### Explained differences', '');
    if (explained.length === 0) out.push('None.', '');
    else {
      for (const c of explained) out.push(`- ${c.name}: ${c.explained}`);
      out.push('');
    }
    const failed = b.checks.filter((c) => !c.ok);
    out.push('### Unexplained differences', '');
    if (failed.length === 0) out.push('None.', '');
    else {
      for (const c of failed) {
        out.push(`- **${c.name}** (legacy ${c.legacy}, v2 ${c.v2})`);
        for (const d of c.details ?? []) out.push(`  - ${d}`);
      }
      out.push('');
    }
  }
  return `${out.join('\n')}\n`;
}

/** @param {any} rec */
export function reconciliationToJson(rec) {
  return `${JSON.stringify(rec, null, 2)}\n`;
}
