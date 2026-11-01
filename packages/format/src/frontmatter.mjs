// Front matter splitting and strict YAML 1.2 (core schema) parsing.
import { LineCounter, isAlias, isScalar, parseDocument, visit } from 'yaml';

/**
 * @typedef {{
 *   status: 'ok'|'none'|'error',
 *   bom: boolean,
 *   fm: Record<string, any>|null,
 *   body: string,
 *   bodyStartLine: number,
 *   error?: {code: 'E100'|'E101', message: string},
 * }} ParsedText
 */

/**
 * @param {string} rawText file contents as decoded UTF-8
 * @returns {ParsedText}
 */
export function parseText(rawText) {
  const bom = rawText.startsWith('﻿');
  const text = bom ? rawText.slice(1) : rawText;
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[0] !== '---') {
    return { status: 'none', bom, fm: null, body: text, bodyStartLine: 1 };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return err(bom, text, 'E100', 'front matter opened with --- on line 1 but never closed');
  }
  const body = lines.slice(close + 1).join('\n');
  const bodyStartLine = close + 2;
  const yamlText = lines.slice(1, close).join('\n');
  const lineCounter = new LineCounter();
  let doc;
  try {
    doc = parseDocument(yamlText, { version: '1.2', schema: 'core', lineCounter });
  } catch (e) {
    return { ...err(bom, body, 'E100', `YAML error: ${firstLine(e)}`), bodyStartLine };
  }
  /** @param {number} offset */
  const at = (offset) => {
    const p = lineCounter.linePos(offset);
    return `line ${p.line + 1}, column ${p.col}`;
  };
  /** @type {string|null} */
  let forbidden = null;
  if (doc.contents) {
    visit(doc, {
      Node(_key, node) {
        if (forbidden) return visit.BREAK;
        const pos = node.range ? at(node.range[0]) : 'front matter';
        if (isAlias(node)) forbidden = `alias at ${pos}`;
        else if (node.anchor) forbidden = `anchor at ${pos}`;
        else if (node.tag) forbidden = `tag ${node.tag} at ${pos}`;
        return undefined;
      },
      Pair(_key, pair) {
        if (!forbidden && isScalar(pair.key) && pair.key.value === '<<' && pair.key.range) {
          forbidden = `merge key at ${at(pair.key.range[0])}`;
        }
        return undefined;
      },
    });
  }
  if (forbidden) {
    return { ...err(bom, body, 'E101', `forbidden YAML feature: ${forbidden}`), bodyStartLine };
  }
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const pos = e.pos ? ` at ${at(e.pos[0])}` : '';
    return { ...err(bom, body, 'E100', `YAML error${pos}: ${firstLine(e)}`), bodyStartLine };
  }
  /** @type {any} */
  let data;
  try {
    data = doc.toJS();
  } catch (e) {
    return { ...err(bom, body, 'E100', `YAML error: ${firstLine(e)}`), bodyStartLine };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ...err(bom, body, 'E100', 'front matter is not a mapping'), bodyStartLine };
  }
  return { status: 'ok', bom, fm: data, body, bodyStartLine };
}

/** @returns {ParsedText} */
function err(bom, body, code, message) {
  return { status: 'error', bom, fm: null, body, bodyStartLine: 1, error: { code, message } };
}

/** @param {any} e */
function firstLine(e) {
  return String(e && e.message ? e.message : e).split('\n')[0];
}
