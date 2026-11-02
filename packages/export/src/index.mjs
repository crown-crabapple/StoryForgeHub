// @storyforge/export - manuscript export (Markdown, DOCX, EPUB, PDF), export verification, portable backup and restore.
// Reads a book folder and produces bytes; never writes into a book folder (the only writes are a restored backup into a new
// folder and an output file the caller names, both through @storyforge/store).
import { renderDocx } from './docx.mjs';
import { renderEpub } from './epub.mjs';
import { assembleManuscript } from './manuscript.mjs';
import { renderMarkdown } from './markdown.mjs';
import { renderPdf } from './pdf.mjs';
import { ExportError, ExportVerificationError } from './text.mjs';
import { INCLUDE_MODES, appendProvenanceSummary, buildEvidencePackage } from './provenance.mjs';
import { verifyExport } from './verify.mjs';

export { assembleManuscript } from './manuscript.mjs';
export { verifyExport } from './verify.mjs';
export { ExportError, ExportVerificationError } from './text.mjs';
export { DEFAULT_RESTORE_LIMITS, RestoreError, createBackup, restoreBackup, restoreBackupFile, writeOutput } from './backup.mjs';
export { writeZip, unzip } from './zip.mjs';
export { INCLUDE_MODES, NOT_LEGAL_ADVICE, lineageSteps, readReceipts } from './provenance.mjs';

export const FORMATS = Object.freeze({
  markdown: { ext: 'md', mime: 'text/markdown; charset=utf-8' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  epub: { ext: 'epub', mime: 'application/epub+zip' },
  pdf: { ext: 'pdf', mime: 'application/pdf' },
});

/**
 * @param {string} bookRoot absolute path of the book folder
 * @param {'markdown' | 'docx' | 'epub' | 'pdf'} format
 * @param {import('./manuscript.mjs').ManuscriptOptions & { include?: 'manuscript' | 'summary' | 'evidence', sceneIds?: string[], verify?: any }} [options] excludeStatuses, sceneTitles,
 *   includeActs, titlePage, page ('letter' | 'a4'); `include` (M05-J07): 'manuscript' (default, no provenance data in the bytes), 'summary' (adds a "Provenance summary" chapter) or
 *   'evidence' (a zip: the manuscript, receipts of `sceneIds` (default: the included scenes) with their objects, verify.json, README.txt; `verify` is the integrity result to store)
 * @returns {Promise<{ bytes: Buffer, filename: string, mime: string, warnings: string[] }>}
 * @throws {ExportError} BAD_FORMAT, BAD_OPTION, NOT_A_BOOK
 * @throws {ExportVerificationError} when the bytes do not match the manuscript
 */
export async function exportBook(bookRoot, format, options = {}) {
  if (!Object.hasOwn(FORMATS, format)) throw new ExportError('BAD_FORMAT', `unknown format: ${format} (use markdown, docx, epub or pdf)`);
  const include = options.include ?? 'manuscript';
  if (!INCLUDE_MODES.includes(include)) throw new ExportError('BAD_OPTION', `include must be one of: ${INCLUDE_MODES.join(', ')}`);
  const manuscript = await assembleManuscript(bookRoot, options);
  if (include === 'summary') await appendProvenanceSummary(manuscript, bookRoot);
  let bytes;
  let warnings = [];
  if (format === 'markdown') bytes = renderMarkdown(manuscript);
  else if (format === 'docx') bytes = renderDocx(manuscript);
  else if (format === 'epub') bytes = renderEpub(manuscript);
  else ({ bytes, warnings } = renderPdf(manuscript));
  const check = verifyExport(bytes, format, manuscript);
  if (!check.ok) throw new ExportVerificationError(check.problems);
  const { ext, mime } = FORMATS[format];
  if (include === 'evidence') {
    const pack = await buildEvidencePackage({ bookRoot, manuscript, manuscriptFile: { bytes, filename: `${manuscript.slug}.${ext}` }, sceneIds: options.sceneIds, verify: options.verify });
    return { bytes: pack.bytes, filename: `${manuscript.slug}-evidence.zip`, mime: 'application/zip', warnings };
  }
  return { bytes, filename: `${manuscript.slug}.${ext}`, mime, warnings };
}
