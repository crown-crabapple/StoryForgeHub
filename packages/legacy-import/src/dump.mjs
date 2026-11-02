// Reads a legacy dump directory (manifest.json + tables/<name>.jsonl). Read-only; the dump is the importer's only input.
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './util.mjs';

export class DumpError extends Error {}

/** A JSON value from a dump column as text: {"$b64": ...} is decoded (lossy when the bytes are not UTF-8). */
export function colText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && typeof v.$b64 === 'string') return Buffer.from(v.$b64, 'base64').toString('utf8');
  return String(v);
}
export const isB64 = (v) => v !== null && typeof v === 'object' && typeof v.$b64 === 'string';
/** True when decoding the base64 value as UTF-8 loses bytes. */
export function lossy(v) {
  const b = Buffer.from(v.$b64, 'base64');
  return !Buffer.from(b.toString('utf8'), 'utf8').equals(b);
}

/**
 * @param {string} dumpDir
 * @returns {{ manifest: any, manifestSha256: string, tables: Map<string, { name: string, manifest: any, rows: any[], raw: string[], skipped: string|null }>, issues: any[] }}
 */
export function readDump(dumpDir) {
  const dir = path.resolve(dumpDir);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new DumpError('not a legacy dump: manifest.json is missing');
  const manifestBytes = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (e) {
    throw new DumpError(`manifest.json is not valid JSON: ${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.tables !== 'object' || manifest.tables === null) throw new DumpError('manifest.json has no tables');
  const issues = [];
  const tables = new Map();
  for (const name of Object.keys(manifest.tables).sort()) {
    const info = manifest.tables[name] ?? {};
    const entry = { name, manifest: info, rows: [], raw: [], skipped: typeof info.skipped === 'string' ? info.skipped : null };
    tables.set(name, entry);
    if (entry.skipped) continue;
    const file = path.join(dir, 'tables', `${name}.jsonl`);
    if (!fs.existsSync(file)) {
      issues.push({ severity: 'error', code: 'dump-corrupt', table: name, message: `tables/${name}.jsonl is missing` });
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (typeof info.sha256 === 'string' && info.sha256 !== sha256Hex(bytes)) {
      issues.push({ severity: 'error', code: 'dump-corrupt', table: name, message: `tables/${name}.jsonl does not match the sha256 in the manifest` });
    }
    const lines = bytes.toString('utf8').split('\n').filter((l) => l.trim() !== '');
    lines.forEach((line, i) => {
      try {
        const row = JSON.parse(line);
        if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('not an object');
        entry.rows.push(row);
        entry.raw.push(line);
      } catch (e) {
        issues.push({ severity: 'error', code: 'dump-corrupt', table: name, id: String(i + 1), message: `line ${i + 1} of tables/${name}.jsonl is not a JSON object (${e.message})` });
      }
    });
    if (typeof info.rows === 'number' && info.rows !== lines.length) {
      issues.push({ severity: 'error', code: 'manifest-mismatch', table: name, message: `the manifest says ${info.rows} rows but tables/${name}.jsonl has ${lines.length}` });
    }
  }
  return { manifest, manifestSha256: sha256Hex(manifestBytes), tables, issues };
}
