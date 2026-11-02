// CF1: a codex field and the text (or a canon research note) give different words for the same fact (contract 3.1).
import { proseLines, WIKI_RE } from '@storyforge/format';
import { fingerprintOf } from './rules.mjs';

const COLOURS = ['black', 'blue', 'brown', 'green', 'grey', 'gray', 'hazel', 'amber', 'red', 'auburn', 'blond', 'blonde', 'white', 'silver', 'violet'];
/** label (lower case) -> nouns the text uses for it */
const COLOUR_LABELS = {
  eyes: ['eye', 'eyes'], 'eye colour': ['eye', 'eyes'], 'eye color': ['eye', 'eyes'],
  hair: ['hair'], 'hair colour': ['hair'], 'hair color': ['hair'],
};
const SYNONYM = { gray: 'grey', blonde: 'blond' };
/** words that end the gap between a colour and its noun ("green scarf and eyes" is not "green eyes") */
const STOP = new Set(['and', 'or', 'but', 'nor', 'with', 'of', 'the', 'a', 'an', 'her', 'his', 'their', 'its', 'in', 'on', 'at', 'to', 'as', 'than', 'not', 'for', 'from', 'by']);

const foldText = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NO_WORD_BOUNDARY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** One word, compared the way the vocabulary does (case-insensitive, grey = gray, blond = blonde). @param {string} w */
const canon = (w) => {
  const l = w.toLowerCase();
  return SYNONYM[l] ?? l;
};

/**
 * Whole-word, case- and diacritic-insensitive matcher for a name and its aliases.
 * @param {unknown[]} names
 * @returns {((foldedText: string) => boolean) | null}
 */
function nameMatcher(names) {
  const folded = [...new Set(names.filter((n) => typeof n === 'string').map(foldText).filter((n) => n !== ''))];
  if (folded.length === 0) return null;
  folded.sort((a, b) => b.length - a.length);
  const alts = folded.map((n) => {
    const first = [...n][0];
    const last = [...n].at(-1);
    const lead = NO_WORD_BOUNDARY.test(first) ? '' : '(?<![\\p{L}\\p{N}])';
    const trail = NO_WORD_BOUNDARY.test(last) ? '' : '(?![\\p{L}\\p{N}])';
    return `${lead}${escapeRe(n)}${trail}`;
  });
  const re = new RegExp(alts.join('|'), 'u');
  return (text) => re.test(text);
}

/** A field value as one word: links and quotes stripped. Null when it is not a single word. @param {unknown} v */
function singleWord(v) {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner) => (inner.includes('|') ? inner.split('|')[1] : inner))
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .trim();
  return /^[\p{L}][\p{L}-]*$/u.test(s) ? s : null;
}

/** Nouns the text uses for a label: Eyes -> eye, eyes; otherwise the label itself, singular and plural. @param {string} label */
function nounsOf(label) {
  const l = label.toLowerCase().trim();
  if (COLOUR_LABELS[l]) return COLOUR_LABELS[l];
  const bare = l.endsWith('s') && l.length > 2 ? l.slice(0, -1) : l;
  return [...new Set([bare, `${bare}s`, l])].filter((n) => /^[\p{L}][\p{L} -]*$/u.test(n));
}

/**
 * The words allowed for each label of an entry type: the type file's `values`, else the built-in colours.
 * @param {import('./model.mjs').Model} model
 * @param {string} type
 * @returns {Map<string, {label: string, words: Set<string>, nouns: string[]}>} lower-case label -> vocabulary
 */
function vocabularies(model, type) {
  /** @type {Map<string, {label: string, words: Set<string>, nouns: string[]}>} */
  const out = new Map();
  for (const label of Object.keys(COLOUR_LABELS)) {
    out.set(label, { label, words: new Set(COLOURS.map(canon)), nouns: COLOUR_LABELS[label] });
  }
  for (const t of model.codexTypes) {
    if (t.fm.type !== type || !t.fm.values || typeof t.fm.values !== 'object' || Array.isArray(t.fm.values)) continue;
    for (const [label, words] of Object.entries(t.fm.values)) {
      if (!Array.isArray(words)) continue;
      const list = words.filter((w) => typeof w === 'string' && /^[\p{L}][\p{L}-]*$/u.test(w));
      const builtin = Object.hasOwn(COLOUR_LABELS, label.toLowerCase());
      out.set(label.toLowerCase(), { label, words: new Set(list.map((w) => (builtin ? canon(w) : w.toLowerCase()))), nouns: nounsOf(label) });
    }
  }
  return out;
}

/** Body text with HTML comments blanked (newlines kept) so line numbers stay true. @param {string} body */
const blankComments = (body) => body.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));

/** Paragraphs of prose: runs of non-blank lines, each line with its file line number. @param {import('@storyforge/format').Doc} d */
function paragraphs(d) {
  /** @type {{ line: number, text: string }[][]} */
  const out = [];
  let cur = [];
  let prev = null;
  for (const [line, text] of proseLines(blankComments(d.body), d.bodyStartLine)) {
    if (text.trim() === '' || (prev !== null && line !== prev + 1)) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    if (text.trim() !== '') cur.push({ line, text });
    prev = line;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Wiki links read as their display text, for name matching only. @param {string} s */
const stripLinks = (s) => s.replace(WIKI_RE, (_, inner) => (inner.includes('|') ? inner.split('|')[1] : inner.split('|')[0]));

/**
 * @param {import('./model.mjs').Model} model
 * @returns {Promise<import('./engine.mjs').Finding[]>}
 */
export async function factConflicts(model) {
  const characters = model.entries.filter((e) => e.fm.type === 'character');
  const matchers = new Map(characters.map((c) => [c, nameMatcher([c.fm.name, ...(Array.isArray(c.fm.aliases) ? c.fm.aliases : [])])]));
  const linkTargets = (c) => new Set([c.fm.slug, c.fm.id, ...(Array.isArray(c.fm.previous_slugs) ? c.fm.previous_slugs : [])].filter((x) => typeof x === 'string'));
  const targets = new Map(characters.map((c) => [c, linkTargets(c)]));

  /** Characters a paragraph mentions: by name or alias, or by a [[link]]. @param {string} text */
  const mentioned = (text) => {
    const folded = foldText(stripLinks(text));
    const linked = [...text.matchAll(WIKI_RE)].map((m) => m[1].split('|')[0].trim());
    return new Set(characters.filter((c) => matchers.get(c)?.(folded) || linked.some((t) => targets.get(c).has(t))));
  };

  /** @type {import('./engine.mjs').Finding[]} */
  const findings = [];

  for (const entry of model.entries) {
    if (!entry.fm.fields || typeof entry.fm.fields !== 'object' || Array.isArray(entry.fm.fields)) continue;
    const vocab = vocabularies(model, String(entry.fm.type));
    for (const [label, raw] of Object.entries(entry.fm.fields)) {
      const v = vocab.get(label.toLowerCase());
      const valueWord = singleWord(raw);
      if (!v || valueWord === null) continue;
      const builtin = Object.hasOwn(COLOUR_LABELS, label.toLowerCase());
      const norm = (w) => (builtin ? canon(w) : w.toLowerCase());
      const value = norm(valueWord);
      if (!v.words.has(value)) continue;
      const others = [...v.words].filter((w) => w !== value);
      if (others.length === 0) continue;
      const wordRe = new RegExp(`(?<![\\p{L}\\p{N}-])(${[...v.words, ...(builtin ? Object.keys(SYNONYM) : [])].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
      const nounRe = new RegExp(`^(,?)((?:\\s+[\\p{L}'-]+){0,2}?)\\s+(${v.nouns.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');

      /** First line of the codex field. */
      let canonSource = null;
      const canonOf = async () => (canonSource ??= await model.fmSource(entry, 'canon', 'entry', `fields.${label}`, ['fields', label]));

      const name = String(entry.fm.name ?? entry.fm.slug);
      /** @param {string} other @param {import('./model.mjs').Source} evidence @param {object} subjectOf */
      const push = async (other, evidence, sceneOrNote) => {
        const key = `${label.toLowerCase()}|${value}|${other}`;
        const canonEvidence = await canonOf();
        const where = evidence.role === 'note' ? `the canon note "${sceneOrNote.fm.title}"` : `the text of "${sceneOrNote.fm.title}"`;
        findings.push({
          fingerprint: fingerprintOf('CF1', entry.fm.id, [entry.fm.id, sceneOrNote.fm.id], key),
          rule: 'CF1', rule_version: 1, severity: 'warning',
          title: `${name}: ${label} ${valueWord} in the codex, ${other} in the text`,
          message: `The codex says ${name}'s ${label} is "${String(raw).trim()}", but ${where} says "${other}": ${evidence.excerpt}`,
          subject: { kind: 'entry', id: entry.fm.id, slug: entry.fm.slug, name },
          sources: [canonEvidence, evidence],
        });
      };

      // text sources: every scene whose characters include the entry
      for (const s of model.scenes) {
        const inScene = s.doc.fm.pov === undefined ? [] : [model.ref(s.doc, 'pov')];
        const cast = new Set([...inScene, ...model.refs(s.doc, 'characters').map((r) => r.doc)].filter(Boolean));
        if (!cast.has(entry)) continue;
        const povIsEntry = model.ref(s.doc, 'pov') === entry;
        const seen = new Set();
        for (const para of paragraphs(s.doc)) {
          const who = mentioned(para.map((l) => l.text).join('\n'));
          const mine = who.has(entry) ? who.size === 1 : who.size === 0 && povIsEntry;
          if (!mine) continue;
          for (const { line, text } of para) {
            for (const m of text.matchAll(wordRe)) {
              const other = norm(m[1]);
              if (other === value || seen.has(other) || !v.words.has(other)) continue;
              const rest = nounRe.exec(text.slice(m.index + m[0].length));
              if (!rest) continue;
              if (rest[2].trim() !== '' && rest[2].trim().split(/\s+/).some((w) => STOP.has(w.toLowerCase()))) continue;
              seen.add(other);
              const from = m.index;
              const to = m.index + m[0].length + rest[0].length;
              await push(other, model.bodySource(s.doc, 'text', 'scene', line, from, to, text.trim().length <= 160 ? text.trim() : text.slice(Math.max(0, from - 60), from + 100).trim()), s.doc);
            }
          }
        }
      }

      // canon research notes that link the entry and state the field with another word
      for (const note of model.research) {
        if (!model.refs(note, 'links').some((r) => r.doc === entry)) continue;
        const labelRe = new RegExp(`^(\\s*(?:[-*+]\\s+)?)(${escapeRe(label)}\\s*:\\s*)([\\p{L}][\\p{L}-]*)\\s*$`, 'iu');
        const seen = new Set();
        for (const [line, text] of proseLines(blankComments(note.body), note.bodyStartLine)) {
          const m = labelRe.exec(text);
          if (!m) continue;
          const other = norm(m[3]);
          if (other === value || seen.has(other) || !v.words.has(other)) continue;
          seen.add(other);
          const from = m[1].length;
          await push(other, model.bodySource(note, 'note', 'research', line, from, from + m[2].length + m[3].length, text.trim()), note);
        }
      }
    }
  }
  return findings;
}
