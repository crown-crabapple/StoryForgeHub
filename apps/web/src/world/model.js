// Series shared worlds, labels and typed fields (M07-J01b): what the UI works out from the API answers. Pure: no DOM, no fetch.
//
// An entry of GET /api/books/:b/codex/entries has `shared: true` and `series: { slug, title }` when it lives in the series' codex, and `labels` (names) when it has any.
// A type of GET /codex/types has `field_defs: [{ label, kind, choices }]` (a plain label is kind `text`).
// GET /labels is { book: { labels: [{ name, color }] }, series: { slug, title, labels } | null }.

/** The notice shown before a shared entry is changed (contract section 7). */
export const SHARED_NOTICE = 'Changes apply to every book in this series.';

/** The badge of a shared entry: "Shared · The Tidewater Books". @param {{ series?: { slug?: string, title?: string | null } | null }} entry */
export const sharedBadge = (entry) => `Shared · ${entry.series?.title ?? entry.series?.slug ?? 'series'}`;

export const SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'book', label: 'This book' },
  { key: 'shared', label: 'Shared' },
];

/** Entries of a scope: all, this book's own, or the series' shared ones. @param {any[]} entries @param {string} scope */
export const inScope = (entries, scope) => (scope === 'book' ? entries.filter((e) => !e.shared) : scope === 'shared' ? entries.filter((e) => e.shared) : entries);

// ---------------------------------------------------------------- typed fields

export const FIELD_KINDS = ['text', 'number', 'date', 'link', 'choice', 'list'];

const LINK_VALUE_RE = /^\[\[[^\]\n|]+(\|[^\]\n]*)?\]\]$/;

/** Is `s` a real calendar date written YYYY-MM-DD? @param {string} s */
function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Does a value fit the kind a type declares? (The validator's rule, W312; an empty value always fits.) @param {string} kind @param {any} value @param {string[]} [choices] */
export function fitsKind(kind, value, choices = []) {
  if (value === undefined || value === null || value === '') return true;
  switch (kind) {
    case 'text': return ['string', 'number', 'boolean'].includes(typeof value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'date': return typeof value === 'string' && isIsoDate(value);
    case 'link': return typeof value === 'string' && LINK_VALUE_RE.test(value.trim());
    case 'choice': return typeof value === 'string' && choices.includes(value);
    case 'list': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    default: return true;
  }
}

/** The text of W312 as the validator words it. @param {string} label @param {string} kind */
export const w312Text = (label, kind) => `${label} should be a ${kind} value`;

/** The declared kind of a field of an entry's type: { kind, choices } or null (an undeclared label is free text). @param {any[]} types @param {string | null | undefined} entryType @param {string} label */
export function fieldDef(types, entryType, label) {
  const def = (types ?? []).find((t) => t.type === entryType)?.field_defs?.find((f) => f.label === label);
  return def ? { kind: def.kind, choices: def.choices ?? [] } : null;
}

/**
 * What to send for a field as typed. A number kind sends a number when the text is one (anything else is kept as typed, so the author can still save
 * it and sees W312); a list is already a list; everything else is text. An unchanged text keeps its original type.
 * @param {string | undefined} kind @param {string} text @param {unknown} original
 */
export function coerceTyped(kind, text, original) {
  if (kind === 'list') return Array.isArray(original) && JSON.stringify(original) === JSON.stringify(parseList(text)) ? original : parseList(text);
  if (original !== undefined && original !== null && typeof original !== 'object' && String(original) === text) return original;
  const t = text.trim();
  if (kind === 'number') return /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t) && Number.isFinite(Number(t)) ? Number(t) : text;
  if (kind === undefined || kind === 'text') return /^(0|-?[1-9]\d{0,14})(\.\d+)?$/.test(t) && String(Number(t)) === t ? Number(t) : text;
  return text;
}

/** A list field's items from text: one per line, trimmed, empty lines dropped. @param {string} text */
export const parseList = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * "Label | kind | a, b" (one line of the New type form) as a field: a plain label stays a string, a typed one is { label, kind, choices? }. Returns
 * { field } or { error }.
 * @param {string} line
 */
export function parseFieldLine(line) {
  const parts = line.split('|').map((p) => p.trim());
  const label = parts[0];
  if (label === '') return { error: 'A field line needs a label.' };
  if (parts.length === 1) return { field: label };
  const kind = parts[1].toLowerCase();
  if (!FIELD_KINDS.includes(kind)) return { error: `"${parts[1]}" is not a field kind. Use one of: ${FIELD_KINDS.join(', ')}.` };
  if (kind === 'choice') {
    const choices = (parts[2] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    if (choices.length === 0) return { error: `The choice field "${label}" needs its choices, for example: ${label} | choice | red, green.` };
    return { field: { label, kind, choices } };
  }
  return kind === 'text' ? { field: label } : { field: { label, kind } };
}

/** The lines of the New type form for a list of fields (the reverse of parseFieldLine). @param {(string | { label: string, kind: string, choices?: string[] })[]} fields */
export const fieldLines = (fields) => fields.map((f) => (typeof f === 'string' ? f : `${f.label} | ${f.kind}${f.kind === 'choice' ? ` | ${(f.choices ?? []).join(', ')}` : ''}`)).join('\n');

// ---------------------------------------------------------------- labels

/** The dark surface the label colours sit on (--surface of the M06 tokens, #16161A) and the others the app draws on. A test keeps these equal to tokens.css. */
export const SURFACES = { '--bg': '#0E0E10', '--surface': '#16161A', '--surface-2': '#1C1C21' };
/** WCAG 1.4.11: a coloured mark that carries meaning needs 3:1 against what is behind it. */
export const LABEL_MIN_CONTRAST = 3;

const lin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (hex) => {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** Is it a colour written #RRGGBB? @param {unknown} hex */
export const isHexColor = (hex) => typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex);

/** The WCAG contrast ratio of a colour against the worst of the dark surfaces, or null when it is not #RRGGBB. @param {string} hex */
export function labelContrast(hex) {
  if (!isHexColor(hex)) return null;
  const l = luminance(hex);
  return Math.min(...Object.values(SURFACES).map((s) => {
    const o = luminance(s);
    return (Math.max(l, o) + 0.05) / (Math.min(l, o) + 0.05);
  }));
}

/** The result of the contrast check: { ok, ratio, text } (text for the screen: it says what to do). @param {string} hex */
export function contrastCheck(hex) {
  const ratio = labelContrast(hex);
  if (ratio === null) return { ok: false, ratio: null, text: 'Write the colour as #RRGGBB, for example #B5446E.' };
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
  return ratio >= LABEL_MIN_CONTRAST
    ? { ok: true, ratio, text: `Contrast ${shown}:1 against the dark background. Fine.` }
    : { ok: false, ratio, text: `Contrast ${shown}:1 against the dark background; it needs ${LABEL_MIN_CONTRAST}:1. Choose a lighter colour.` };
}

/** A map from folded label name to its definition { name, color, scope }. @param {{ name: string, color: string | null, scope?: string }[] | null | undefined} defs */
export const labelMap = (defs) => new Map((defs ?? []).map((d) => [d.name.trim().toLowerCase(), d]));

/** The names to offer in a filter: the defined labels, then any a document uses that nothing defines. @param {{ name: string }[] | null | undefined} defs @param {string[][]} used */
export function labelChoices(defs, used) {
  const out = (defs ?? []).map((d) => d.name);
  const seen = new Set(out.map((n) => n.toLowerCase()));
  for (const list of used) for (const n of list ?? []) if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  return out;
}

/** Does a document carry the label? An empty filter matches everything. @param {{ labels?: string[] }} doc @param {string} name */
export const hasLabel = (doc, name) => name === '' || (doc.labels ?? []).some((l) => l.toLowerCase() === name.toLowerCase());

// ---------------------------------------------------------------- links

/** The text a cross-book or shared link target is written as, for a picked item. @param {{ link: string }} item */
export const insertTextOf = (item) => item.link.replace(/^\[\[|\]\]$/g, '');

/**
 * Where a cross-book link leads: { href, name } or null. `ref` is "book-slug:target"; `targets` is GET /link-targets. A target of another book that is an entry opens
 * in that book's Codex, a thread on its Threads view, an event on its Timeline.
 * A `[[series-slug:slug]]` link names a shared entry: it opens in the Codex of `bookId`, the book being read.
 * @param {string} ref @param {any} targets @param {string} bookId @param {(bookId: string, entryId: string) => string} codexHref
 */
export function crossBookTarget(ref, targets, bookId, codexHref) {
  const at = ref.indexOf(':');
  if (at <= 0 || !targets) return null;
  const prefix = ref.slice(0, at);
  const slug = ref.slice(at + 1);
  const book = (targets.books ?? []).find((b) => b.slug === prefix);
  const item = book?.items.find((i) => i.slug === slug || i.id === slug);
  if (book && item) {
    const id = encodeURIComponent(book.id);
    if (item.kind === 'thread') return { href: `/books/${id}?view=threads&thread=${encodeURIComponent(item.slug)}`, name: item.title };
    if (item.kind === 'event') return { href: `/books/${id}/timeline?event=${encodeURIComponent(item.slug)}`, name: item.title };
    return { href: codexHref(book.id, item.id), name: item.title };
  }
  if (targets.series && targets.series.slug === prefix) {
    const shared = targets.series.items.find((i) => i.slug === slug || i.id === slug);
    if (shared) return { href: codexHref(bookId, shared.id), name: shared.title };
  }
  return null;
}
