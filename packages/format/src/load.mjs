// Load one markdown file into a document record, reporting parse-level diagnostics.
import path from 'node:path';
import { readText } from './fs.mjs';
import { KINDS } from './schema.mjs';
import { parseText } from './frontmatter.mjs';

/**
 * @typedef {{
 *   rel: string,          // path relative to the book (or library/series) root
 *   file: string,         // path relative to the validated root
 *   archived: boolean,
 *   kind: string|null,    // null for plain notes
 *   fm: Record<string, any>,
 *   body: string,
 *   bodyStartLine: number,
 * }} Doc
 */

const FILENAME_RE = /^[0-9a-z-]+\.md$/;
const SCHEMA_RE = /^storyforge\.([a-z]+|codex-type|continuity-exception)\/v(\d+)$/;

/**
 * @param {string} absPath
 * @param {string} rel path relative to the root the document belongs to
 * @param {string} file path relative to the validated root
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @returns {Promise<{doc: Doc|null, unsupported: boolean}>} doc is null when the file failed to
 *   parse or has an unsupported schema (it then gets no further diagnostics, spec 1.2 / 10)
 */
export async function loadDoc(absPath, rel, file, add) {
  let text;
  try {
    text = await readText(absPath);
  } catch (e) {
    add('E100', file, '', `file cannot be read: ${e.message}`);
    return { doc: null, unsupported: false };
  }
  const parsed = parseText(text);
  if (parsed.status === 'error') {
    add(parsed.error.code, file, '', parsed.error.message);
    return { doc: null, unsupported: false };
  }

  let kind = null;
  const fm = parsed.fm ?? {};
  if (parsed.status === 'ok' && fm.schema !== undefined && fm.schema !== null) {
    const s = fm.schema;
    const m = typeof s === 'string' ? SCHEMA_RE.exec(s) : null;
    if (m) {
      if (Number(m[2]) > 1) {
        add('E006', file, 'schema', `unsupported schema ${s}`);
        return { doc: null, unsupported: true };
      }
      if (Object.hasOwn(KINDS, m[1])) kind = m[1];
    } else if (typeof s !== 'string' || s.startsWith('storyforge.')) {
      add('E102', file, 'schema', 'schema must look like storyforge.<kind>/v<major>');
      return { doc: null, unsupported: false };
    }
  }

  if (parsed.bom) add('W204', file, '', 'byte-order mark found and ignored');
  if (!FILENAME_RE.test(path.posix.basename(rel)) || path.posix.basename(rel).length > 80) {
    add('W203', file, '', 'filename breaks the naming rules (a-z, 0-9, hyphen, .md, max 80 chars)');
  }

  return {
    doc: {
      rel,
      file,
      archived: rel.startsWith('archive/'),
      kind,
      fm,
      body: parsed.body,
      bodyStartLine: parsed.bodyStartLine,
    },
    unsupported: false,
  };
}
