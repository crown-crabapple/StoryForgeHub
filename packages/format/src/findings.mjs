// Findings foundation (M13-J01): the finding contract, the validation result contract and capability states.
// Pure: no node:* import, no I/O, no dependency. SHA-256 is never computed here; callers hash and pass the digest in.
// The web app keeps a byte-identical copy (apps/web/src/findings/findings.js). Change this file, then copy it.

export const FINDING_SCHEMA = 'storyforge.finding/v1';
export const VALIDATION_SCHEMA = 'storyforge.validation/v1';

export const FINDING_CATEGORIES = ['grammar', 'spelling', 'punctuation', 'style', 'terminology', 'repetition', 'rhythm'];
export const FINDING_SEVERITIES = ['error', 'warning', 'info'];
export const VALIDATION_OUTCOMES = ['passed', 'passed-with-warnings', 'failed', 'not-checked', 'unavailable', 'error', 'cancelled'];
export const VALIDATION_SEVERITIES = ['fatal', 'error', 'warning', 'info', 'usage'];
export const CAPABILITY_STATES = ['ready', 'disabled', 'unavailable', 'running', 'cancelled', 'failed', 'completed'];
export const CAPABILITY_EVENTS = ['enable', 'disable', 'start', 'finish', 'fail', 'cancel', 'lose', 'restore'];

const ENGINE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SCENE_ID_RE = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;
const FINDING_ID_RE = /^fnd_[0-9a-f]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * @typedef {{ sha256: string, length: number }} FindingSource
 * @typedef {{ from: number, to: number }} FindingRange
 * @typedef {{ sceneId: string, from: number, to: number, text: string }} FindingRelated
 * @typedef {{
 *   schema: 'storyforge.finding/v1', id: string, engine: string, engineVersion: string, ruleId: string,
 *   category: string, severity: string, advisory: boolean, message: string, sceneId: string,
 *   source: FindingSource, range: FindingRange, original: string, replacements: string[], related?: FindingRelated[]
 * }} Finding
 * @typedef {{ code: string, severity: string, message: string, location: { path: string, line: number, column: number } | null, sceneId: string | null, chapterId: string | null }} ValidationMessage
 * @typedef {{
 *   schema: 'storyforge.validation/v1', validator: string, validatorVersion: string | null,
 *   artifact: { kind: 'epub' | 'pdf', sha256: string, name: string }, checkedAt: string | null, outcome: string,
 *   messages: ValidationMessage[], report: { path: string } | null, detail: string | null
 * }} ValidationResult
 * @typedef {{ field: string, message: string }} FieldProblem
 */

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The stable id of a finding: `fnd_` + 16 lower-case hex of a 64-bit FNV-1a hash. Not a security hash.
 * The hashed text is engine, ruleId, sceneId, range.from, range.to and original, joined by U+0000.
 * FNV-1a 64: start at 0xcbf29ce484222325; for each byte, XOR it in, then multiply by 0x100000001b3 modulo 2^64.
 * The bytes are the UTF-16 code units of the text, each fed low byte first, then high byte (BigInt arithmetic).
 * @param {Pick<Finding, 'engine' | 'ruleId' | 'sceneId' | 'range' | 'original'>} f
 * @returns {string}
 */
export function findingId(f) {
  const text = [f.engine, f.ruleId, f.sceneId, String(f.range.from), String(f.range.to), f.original].join('\u0000');
  const MASK = 0xffffffffffffffffn;
  const PRIME = 0x100000001b3n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    const u = text.charCodeAt(i);
    h = ((h ^ BigInt(u & 0xff)) * PRIME) & MASK;
    h = ((h ^ BigInt(u >> 8)) * PRIME) & MASK;
  }
  return `fnd_${h.toString(16).padStart(16, '0')}`;
}

/**
 * Every rule of a finding that can be checked without the body. Empty list: valid.
 * @param {any} f @returns {FieldProblem[]}
 */
export function findingProblems(f) {
  /** @type {FieldProblem[]} */
  const out = [];
  const bad = (field, message) => out.push({ field, message });
  if (!isMap(f)) return [{ field: '', message: 'a finding is a JSON object' }];
  if (f.schema !== FINDING_SCHEMA) bad('schema', `schema must be ${FINDING_SCHEMA}`);
  if (typeof f.engine !== 'string' || !ENGINE_RE.test(f.engine)) bad('engine', 'engine must be lower-case letters, digits and hyphens, starting with a letter (at most 32)');
  if (!isStr(f.engineVersion, 64)) bad('engineVersion', 'engineVersion must be a non-empty string of at most 64 characters');
  if (!isStr(f.ruleId, 128)) bad('ruleId', 'ruleId must be a non-empty string of at most 128 characters');
  if (!FINDING_CATEGORIES.includes(f.category)) bad('category', `category must be one of ${FINDING_CATEGORIES.join(', ')}`);
  if (!FINDING_SEVERITIES.includes(f.severity)) bad('severity', `severity must be one of ${FINDING_SEVERITIES.join(', ')}`);
  if (typeof f.advisory !== 'boolean') bad('advisory', 'advisory must be true or false');
  if (!isStr(f.message, 1000)) bad('message', 'message must be a non-empty string of at most 1000 characters');
  if (typeof f.sceneId !== 'string' || !SCENE_ID_RE.test(f.sceneId)) bad('sceneId', 'sceneId must be scene_ plus a 26-character ULID');

  let sourceOk = false;
  if (!isMap(f.source)) bad('source', 'source must be { sha256, length }');
  else {
    if (typeof f.source.sha256 !== 'string' || !SHA256_RE.test(f.source.sha256)) bad('source.sha256', 'source.sha256 must be 64 lower-case hex characters');
    if (!Number.isInteger(f.source.length) || f.source.length < 1) bad('source.length', 'source.length must be a positive integer');
    else sourceOk = true;
  }

  let rangeOk = false;
  if (!isMap(f.range)) bad('range', 'range must be { from, to }');
  else if (!Number.isInteger(f.range.from) || !Number.isInteger(f.range.to)) bad('range', 'range.from and range.to must be integers');
  else if (f.range.from < 0 || f.range.from >= f.range.to) bad('range', 'range must satisfy 0 <= from < to');
  else if (sourceOk && f.range.to > f.source.length) bad('range', 'range.to must not pass source.length');
  else rangeOk = true;

  if (typeof f.original !== 'string') bad('original', 'original must be a string');
  else if (rangeOk && f.original.length !== f.range.to - f.range.from) bad('original', 'original must be as long as the range (to - from)');
  else if (f.original.length === 0) bad('original', 'original must not be empty');

  if (!Array.isArray(f.replacements)) bad('replacements', 'replacements must be a list');
  else {
    if (f.replacements.length > 8) bad('replacements', 'at most 8 replacements');
    f.replacements.forEach((r, i) => { if (typeof r !== 'string') bad(`replacements.${i}`, 'a replacement must be a string'); });
  }

  if (f.related !== undefined) {
    if (!Array.isArray(f.related)) bad('related', 'related must be a list');
    else {
      if (f.related.length > 20) bad('related', 'at most 20 related occurrences');
      f.related.forEach((r, i) => {
        const at = `related.${i}`;
        if (!isMap(r)) return bad(at, 'a related occurrence is { sceneId, from, to, text }');
        if (typeof r.sceneId !== 'string' || !SCENE_ID_RE.test(r.sceneId)) bad(`${at}.sceneId`, 'sceneId must be scene_ plus a 26-character ULID');
        if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 0 || r.from >= r.to) bad(`${at}.range`, 'from and to must be integers with 0 <= from < to');
        if (typeof r.text !== 'string' || r.text.length > 200) bad(`${at}.text`, 'text must be a string of at most 200 characters');
        return undefined;
      });
    }
  }

  if (typeof f.id !== 'string' || !FINDING_ID_RE.test(f.id)) bad('id', 'id must be fnd_ plus 16 lower-case hex characters');
  else if (typeof f.engine === 'string' && typeof f.ruleId === 'string' && typeof f.sceneId === 'string' && rangeOk && typeof f.original === 'string' && f.id !== findingId(f)) bad('id', 'id does not match the finding (see findingId)');
  return out;
}

/**
 * Does the finding still describe this text? `body` has LF line breaks. Does not hash.
 * @param {Finding} f @param {string} body
 */
export function findingMatches(f, body) {
  return typeof body === 'string'
    && body.length === f.source.length
    && body.slice(f.range.from, f.range.to) === f.original;
}

/**
 * Every rule of a validation result that can be checked on its own. Empty list: valid.
 * @param {any} r @returns {FieldProblem[]}
 */
export function validationProblems(r) {
  /** @type {FieldProblem[]} */
  const out = [];
  const bad = (field, message) => out.push({ field, message });
  if (!isMap(r)) return [{ field: '', message: 'a validation result is a JSON object' }];
  if (r.schema !== VALIDATION_SCHEMA) bad('schema', `schema must be ${VALIDATION_SCHEMA}`);
  const outcomeOk = VALIDATION_OUTCOMES.includes(r.outcome);
  if (!outcomeOk) bad('outcome', `outcome must be one of ${VALIDATION_OUTCOMES.join(', ')}`);
  const nothingRan = r.outcome === 'unavailable' || r.outcome === 'not-checked';
  if (!isStr(r.validator, 64)) bad('validator', 'validator must be a non-empty string');
  if (r.validatorVersion === null) {
    if (outcomeOk && !nothingRan) bad('validatorVersion', 'validatorVersion may be null only when the outcome is unavailable or not-checked');
  } else if (!isStr(r.validatorVersion, 64)) bad('validatorVersion', 'validatorVersion must be a non-empty string (or null when nothing ran)');

  if (!isMap(r.artifact)) bad('artifact', 'artifact must be { kind, sha256, name }');
  else {
    if (r.artifact.kind !== 'epub' && r.artifact.kind !== 'pdf') bad('artifact.kind', 'artifact.kind must be epub or pdf');
    if (typeof r.artifact.sha256 !== 'string' || !SHA256_RE.test(r.artifact.sha256)) bad('artifact.sha256', 'artifact.sha256 must be 64 lower-case hex characters');
    if (!isStr(r.artifact.name, 255) || /[\\/]/.test(r.artifact.name)) bad('artifact.name', 'artifact.name must be a file name only (no folder)');
  }

  if (r.checkedAt === null) {
    if (outcomeOk && (r.outcome === 'passed' || r.outcome === 'passed-with-warnings' || r.outcome === 'failed')) bad('checkedAt', 'checkedAt must be set when the validator ran to a verdict');
  } else if (typeof r.checkedAt !== 'string' || !ISO_UTC_RE.test(r.checkedAt) || Number.isNaN(Date.parse(r.checkedAt))) bad('checkedAt', 'checkedAt must be an ISO 8601 UTC time (or null when nothing ran)');

  if (!Array.isArray(r.messages)) bad('messages', 'messages must be a list');
  else {
    r.messages.forEach((m, i) => {
      const at = `messages.${i}`;
      if (!isMap(m)) return bad(at, 'a message is an object');
      if (!isStr(m.code, 64)) bad(`${at}.code`, 'code must be a non-empty string');
      if (!VALIDATION_SEVERITIES.includes(m.severity)) bad(`${at}.severity`, `severity must be one of ${VALIDATION_SEVERITIES.join(', ')}`);
      if (typeof m.message !== 'string' || m.message === '') bad(`${at}.message`, 'message must be a non-empty string');
      if (m.location !== null) {
        // line and column are 1-based, or null when the validator does not know them
        const pos = (v) => v === null || (Number.isInteger(v) && v >= 1);
        if (!isMap(m.location) || typeof m.location.path !== 'string' || !pos(m.location.line) || !pos(m.location.column)) bad(`${at}.location`, 'location must be { path, line, column } (line and column 1 or more, or null) or null');
      }
      if (m.sceneId !== null && (typeof m.sceneId !== 'string' || !SCENE_ID_RE.test(m.sceneId))) bad(`${at}.sceneId`, 'sceneId must be a scene id or null');
      if (m.chapterId !== null && (typeof m.chapterId !== 'string' || !/^chap_[0-9A-HJKMNP-TV-Z]{26}$/.test(m.chapterId))) bad(`${at}.chapterId`, 'chapterId must be a chapter id or null');
      return undefined;
    });
  }

  if (r.report !== null && (!isMap(r.report) || typeof r.report.path !== 'string' || r.report.path === '')) bad('report', 'report must be { path } or null');

  const needsDetail = r.outcome === 'unavailable' || r.outcome === 'error' || r.outcome === 'cancelled';
  if (r.detail === null) {
    if (needsDetail) bad('detail', 'detail must say why when the outcome is unavailable, error or cancelled');
  } else if (typeof r.detail !== 'string' || r.detail === '') bad('detail', 'detail must be plain-language text or null');
  else if (outcomeOk && !needsDetail) bad('detail', 'detail must be null unless the outcome is unavailable, error or cancelled');
  return out;
}

/**
 * The outcome a list of validator messages implies: failed on any fatal or error, else passed-with-warnings on any warning, else passed.
 * @param {{ severity: string }[]} messages
 * @returns {'passed' | 'passed-with-warnings' | 'failed'}
 */
export function outcomeOf(messages) {
  if (messages.some((m) => m.severity === 'fatal' || m.severity === 'error')) return 'failed';
  if (messages.some((m) => m.severity === 'warning')) return 'passed-with-warnings';
  return 'passed';
}

/** Only `passed` and `passed-with-warnings` are clean. Everything else (not-checked, unavailable, error, cancelled, failed, unknown) is not. @param {{ outcome: string }} r */
export function isCleanValidation(r) {
  return r?.outcome === 'passed' || r?.outcome === 'passed-with-warnings';
}

/**
 * The next capability state. Any move not listed in the contract returns `state` unchanged (no throw).
 * @param {string} state one of CAPABILITY_STATES @param {string} event one of CAPABILITY_EVENTS
 * @returns {string}
 */
export function nextCapability(state, event) {
  if (!CAPABILITY_STATES.includes(state) || !CAPABILITY_EVENTS.includes(event)) return state;
  switch (event) {
    case 'enable': return state === 'disabled' ? 'ready' : state;
    case 'disable': return 'disabled';
    case 'start': return state === 'ready' || state === 'completed' || state === 'failed' || state === 'cancelled' ? 'running' : state;
    case 'finish': return state === 'running' ? 'completed' : state;
    case 'fail': return state === 'running' ? 'failed' : state;
    case 'cancel': return state === 'running' ? 'cancelled' : state;
    case 'lose': return state === 'disabled' ? state : 'unavailable';
    case 'restore': return state === 'unavailable' ? 'ready' : state;
    default: return state;
  }
}

/** Only a completed run may be shown as "no problems found". @param {string} state */
export function mayShowClean(state) {
  return state === 'completed';
}
