// Shared inputs for the M03-J02 editor tests (not a test file: the web test glob is test/*.test.mjs).
// Test-only: reads the valid fixtures, builds the synthetic torture body and the line-ending variants.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../../packages/format/fixtures/valid');

/** Split a scene file into its front-matter bytes (through the closing `---` line break) and body, exactly. */
export function splitScene(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return null;
  return { frontMatter: m[0], body: text.slice(m[0].length) };
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.md')) yield full;
  }
}

/** Every scene body in every valid fixture: [{ name, file, body }] with the bytes exactly as on disk. */
export function fixtureBodies() {
  const out = [];
  for (const fx of fs.readdirSync(FIXTURES)) {
    for (const file of walk(path.join(FIXTURES, fx))) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/^schema: storyforge\.scene\/v1\r?$/m.test(text.slice(0, 400))) continue;
      const parts = splitScene(text);
      if (parts) out.push({ name: `${fx}/${path.relative(path.join(FIXTURES, fx), file).split(path.sep).join('/')}`, file, body: parts.body });
    }
  }
  return out;
}

/** A synthetic body that exercises every Markdown construct a rich-text round trip would rewrite. 77+ lines. */
export const TORTURE = [
  '# Chapter heading with `code` and a [link](http://example.com "A title")',
  '',
  'Plain opening line with *emphasis*, _emphasis_, **strong**, __strong__ and ***both***.',
  'A soft-wrapped line continues',
  'on the next physical line and',
  'on a third.',
  '',
  '<!-- note: check the tide times against chapter 3 -->',
  '<!-- opaque: left by the first draft, keep -->',
  '<!--',
  '  a multi-line comment',
  '  with  odd   spacing',
  '-->',
  '',
  'Wiki-links: [[pell]], [[saltmarks|the saltmarks]] and [[grafting-knife]] in one line.',
  'Citations: [@admiralty-tables] and [@admiralty-tables, p. 4].',
  '',
  '***',
  '',
  '* * *',
  '',
  'Hard break with two trailing spaces  ',
  'next line after the hard break\\',
  'and a backslash hard break.',
  '',
  '',
  '',
  'Three blank lines precede this paragraph.',
  '',
  '- dash bullet one',
  '- dash bullet two',
  '  - nested dash bullet',
  '',
  '* star bullet one',
  '* star bullet two',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '> A block quote that wraps',
  '> across two lines.',
  '>',
  '> And a second quoted paragraph.',
  '',
  '```js',
  'const x = "<!-- not a comment -->";',
  'function f(a, b) { return a * b; }',
  '```',
  '',
  '~~~',
  'tilde fenced code',
  '~~~',
  '',
  '    indented code block',
  '    with a second line',
  '',
  'Literal brackets [sic], snake_case_name, __init__ and 2 * 3 * 4 stay literal.',
  'Escapes: \\*not italic\\*, \\_under\\_, \\[not a link\\] and a trailing backslash \\\\.',
  'Link with title: [text](http://example.com/a_b "Title with *stars*").',
  'Autolink <http://example.com> and html <span class="x">inline</span>.',
  '',
  'Unicode: café, naïve, “curly quotes”, em—dash, ellipsis…, ½, Über.',
  'Japanese: こんにちは、世界。物語の始まり。',
  'Emoji: 🌊🔑 and a ZWJ sequence 👩‍🌾 and flag 🇯🇵.',
  'Tabs\tinside\tthe\tline and trailing tab\t',
  '   leading spaces on a prose line',
  '',
  'The quick brown fox jumps over the lazy dog and keeps running past the old stone wall.',
  'Another ordinary sentence follows so there is always a plain line to edit.',
  '',
  '## Second heading',
  '',
  'Setext heading',
  '==============',
  '',
  'Closing paragraph before the end of the scene.',
].join('\n');

export const toLF = (s) => s.replace(/\r\n/g, '\n');
export const toCRLF = (s) => toLF(s).replace(/\n/g, '\r\n');
export const stripFinalNewline = (s) => s.replace(/\r?\n$/, '');
export const withFinalNewline = (s) => (/\n$/.test(s) ? s : s + (s.includes('\r\n') ? '\r\n' : '\n'));

/**
 * Every shape a body can take at load: as on disk, LF, CRLF, each with and without a final newline.
 * @returns {{ label: string, text: string }[]} (de-duplicated by text)
 */
export function variantsOf(body) {
  const base = toLF(body);
  const seen = new Set();
  const out = [];
  const add = (label, text) => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ label, text });
  };
  add('as-on-disk', body);
  add('LF', base);
  add('CRLF', toCRLF(base));
  add('LF no final newline', stripFinalNewline(base));
  add('CRLF no final newline', toCRLF(stripFinalNewline(base)));
  add('LF with final newline', withFinalNewline(base));
  add('CRLF with final newline', toCRLF(withFinalNewline(base)));
  return out;
}

/** All bodies the round-trip tests run over: fixtures + torture. */
export const allBodies = () => [...fixtureBodies().map((f) => ({ name: f.name, body: f.body })), { name: 'torture', body: TORTURE }, { name: 'torture (final newline)', body: TORTURE + '\n' }];

/** Deterministic PRNG (no Math.random, so failures reproduce). */
export function prng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
