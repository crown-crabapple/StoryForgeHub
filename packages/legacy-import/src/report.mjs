// The owner-readable dry-run report (Markdown) and the JSON form of a plan. Both are deterministic: no dates, no paths of the dump.
import { byCodePoint } from './util.mjs';

export const ISSUE_EXPLANATIONS = {
  'dump-corrupt': 'A table file in the dump is missing, unreadable or does not match the checksum in the manifest. Dump again before importing.',
  'manifest-mismatch': 'The manifest promises a different number of rows than the table file holds. Dump again before importing.',
  'book-not-found': 'A book named with --book matches no legacy book (it is matched by legacy id, folder name or slug).',
  'unknown-table': 'The legacy database has a table this importer does not know (the legacy schema changed). Its rows are kept verbatim under legacy/tables/ so nothing is lost.',
  'chapter-order-tie': 'Two chapters had the same sort order and number, so the legacy order is ambiguous. They were ordered by legacy id; check the order in the chapter table.',
  'act-order-conflict': 'A chapter belongs to an earlier act than the chapter before it. It was moved into the later act so the book order stays valid.',
  'chapter-without-act': 'A chapter had no act while the book has acts. It was placed in the act of the chapter before it.',
  'chapter-archived': 'An archived chapter is planned under archive/ with the same layout. Archived chapters are numbered after the live ones.',
  'chapter-empty': 'A chapter has no text. Only its chapter.md is planned.',
  'scene-comment-only': 'A part of a chapter between two scene breaks holds only a comment. The legacy app dropped such parts; the import keeps them as their own scene.',
  'scene-heading-only': 'A part of a chapter between two scene breaks holds only a heading. The legacy app dropped such parts; the import keeps them as their own scene.',
  'scene-empty': 'A part of a chapter between two scene breaks is empty. It is kept as an empty scene so the text re-joins exactly.',
  'scenes-cache-dropped': 'The legacy scene labels and summaries are matched to scenes by position only. This chapter changed since they were saved, so they were not trusted and not applied.',
  'scene-label-not-applied': 'A legacy scene label has no v2 equivalent here; it is kept as x-legacy-label on the scene.',
  'unknown-link': 'A [[link]] names something that is not an entry, thread or event. In scenes the text is never changed (the v2 validator will show a broken link to fix); elsewhere it became plain text.',
  'link-normalised': 'A [[link]] was written with a different spelling than the slug it points at; it now uses the slug.',
  'link-flattened': 'A Markdown link pointed at a file that does not exist in the new folder; the link became plain text with the target in brackets.',
  'slug-collision': 'Two things had the same slug in the shared entry/thread/event namespace. The later one got a number and keeps the old slug in previous_slugs.',
  'slug-normalised': 'A legacy slug was not in the v2 slug form (lower case a-z, 0-9, hyphens); it was normalised and the old one is kept in previous_slugs.',
  'cite-key-normalised': 'A source cite key was not in the v2 form; it was normalised and the original kept as x-legacy-cite-key.',
  'chapter-ref-unresolved': 'A legacy chapter reference (like "4", "3.5" or "prologue") matches no chapter. The item was kept, without a scene link.',
  'cast-unresolved': 'A cast member or character slug is not a codex entry, so it was not put in front matter; it is noted in the chapter or thread text.',
  'related-unresolved': 'A related slug is not a codex entry; it is kept as a comment.',
  'state-unresolved': 'A legacy state change or knowledge fact names something that is not a codex entry; it is kept as a comment in the event.',
  'state-type-mismatch': 'A legacy state change does not fit the entry types v2 expects (for example "died" on an object); it is kept as a comment in the event.',
  'unknown-status': 'A legacy status value was not one of the known ones; a default was used.',
  'series-not-modelled': 'The legacy data has no series entity; the series name is kept as x-legacy-series on the book.',
  'readme-chapter': 'A legacy README file stored as a chapter; it is not manuscript text and is kept as data.',
  'invalid-utf8': 'A value was not valid UTF-8. The text shows U+FFFD where bytes were lost, and the exact bytes are kept in legacy/tables/.',
  'orphan-row': 'A row refers to a parent row that does not exist; it was not imported.',
  'book-untitled': 'A book row has no title and no folder.',
  'unhandled-row': 'A row had no importer rule. This is a bug in the importer; please report it.',
};

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const idFrom = (f) => /^id: (\S+)$/m.exec(Buffer.from(f.bytes).toString('utf8').slice(0, 600))?.[1] ?? '';

/** @param {any} plan @returns {string} */
export function renderReport(plan) {
  const out = [];
  const w = (s = '') => out.push(s);
  const errors = plan.issues.filter((i) => i.severity === 'error').length;
  const warnings = plan.issues.filter((i) => i.severity === 'warning').length;
  w('# Legacy import: dry run report');
  w();
  w(`Dump manifest sha256: \`${plan.dump.sha256}\` (dumper version ${plan.dump.dumper_version})  `);
  w(`Importer version: ${plan.importer_version}  `);
  w(`Books planned: ${plan.books.length}. Files planned: ${plan.summary.files}. Disposition coverage: ${(plan.summary.coverage * 100).toFixed(0)}%.  `);
  w(`Issues: ${errors} error(s), ${warnings} warning(s), ${plan.issues.length - errors - warnings} note(s).`);
  w();
  for (const b of plan.books) {
    w(`## Book: ${b.title} (\`${b.slug}\`)`);
    w();
    w(`Legacy id \`${b.legacy_id}\`. Everything below would be created under \`${b.root}\`.`);
    w();
    w('### What becomes what');
    w();
    w('| Destination | Files | Legacy rows feeding them |');
    w('|---|---|---|');
    const kinds = new Map();
    for (const f of b.files) {
      const k = kinds.get(f.kind) ?? { files: 0, rows: new Set() };
      k.files += 1;
      for (const s of f.sources ?? []) k.rows.add(`${s.table}#${s.id}`);
      kinds.set(f.kind, k);
    }
    for (const [kind, k] of [...kinds.entries()].sort((x, y) => byCodePoint(x[0], y[0]))) {
      const perTable = new Map();
      for (const r of k.rows) perTable.set(r.split('#')[0], (perTable.get(r.split('#')[0]) ?? 0) + 1);
      w(`| ${kind} | ${k.files} | ${[...perTable.entries()].sort((x, y) => byCodePoint(x[0], y[0])).map(([t, n]) => `${t}: ${n}`).join(', ')} |`);
    }
    w();
    w('### Chapters and scenes, in the new order');
    w();
    w('| Legacy num | Chapter | Act | Title | Scenes | Bytes | |');
    w('|---|---|---|---|---|---|---|');
    for (const c of plan.chapters.filter((x) => x.book === b.slug)) w(`| ${cell(c.num)} | ${c.chapter} | ${c.act} | ${cell(c.title)} | ${c.scenes.length} | ${c.body_bytes} | ${c.archived ? 'archived' : ''} |`);
    w();
    w('### Destination tree');
    w();
    w('| Path | Kind | Proposed ID |');
    w('|---|---|---|');
    for (const f of b.files) w(`| \`${f.path}\` | ${f.kind} | ${idFrom(f)} |`);
    w();
  }
  w('## Issues');
  w();
  if (plan.issues.length === 0) w('None.');
  const byCode = new Map();
  for (const i of plan.issues) byCode.set(i.code, [...(byCode.get(i.code) ?? []), i]);
  for (const [code, list] of [...byCode.entries()].sort((x, y) => byCodePoint(x[0], y[0]))) {
    const sev = list.some((i) => i.severity === 'error') ? 'error' : list.some((i) => i.severity === 'warning') ? 'warning' : 'note';
    w(`### ${code} (${sev}, ${list.length})`);
    w();
    w(ISSUE_EXPLANATIONS[code] ?? 'See the messages below.');
    w();
    for (const i of list) w(`- ${i.table ? `${i.table}${i.id !== undefined ? ` #${i.id}` : ''}: ` : ''}${i.message}`);
    w();
  }
  w('## Every legacy table and what happens to its rows');
  w();
  const ds = ['converted', 'merged', 'history', 'kept-as-data', 'derived', 'server-only', 'skipped'];
  w(`| Table | Rows | ${ds.join(' | ')} |`);
  w(`|---|---|${ds.map(() => '---').join('|')}|`);
  for (const [name, t] of Object.entries(plan.summary.tables)) w(`| ${name}${t.skipped ? ` (not dumped: ${t.not_dumped} rows, ${t.skipped})` : ''} | ${t.rows} | ${ds.map((d) => t.by_disposition[d] ?? 0).join(' | ')} |`);
  w();
  w('- converted: becomes, or feeds, a v2 file. merged: folded into another row\'s file. history: written under legacy/history/.');
  w('- kept-as-data: written unchanged under legacy/tables/. derived: a cache v2 rebuilds. server-only: accounts and tokens, never imported.');
  w('- skipped: not imported, with a reason in the plan JSON.');
  w();
  w('Nothing was written.');
  return `${out.join('\n')}\n`;
}

/** The plan as JSON text: file bytes are replaced by their size (the sha256 is already there), so the output stays readable. */
export function planToJson(plan) {
  return `${JSON.stringify(plan, (k, v) => (k === 'bytes' && v && typeof v === 'object' ? undefined : v), 2)}\n`;
}
