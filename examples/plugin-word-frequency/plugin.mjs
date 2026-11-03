#!/usr/bin/env node
// Word frequency: a StoryForge plugin that only reads (permission `read`). No dependencies; Node 22 or newer.
//
//   STORYFORGE_TOKEN=<token> node plugin.mjs --book <book-slug> [--url http://127.0.0.1:4317] [--top 5]
//
// It lists the book over API v1, reads every scene, and prints the most used words of each chapter. StoryForge never runs this file: you start it, with a token
// you granted in Settings -> Plugins, and it can lose nothing but that token. See docs/plugins.md.
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const base = (flag('url', process.env.STORYFORGE_URL ?? 'http://127.0.0.1:4317')).replace(/\/+$/, '');
const token = process.env.STORYFORGE_TOKEN;
const bookSlug = flag('book', undefined);
const top = Number(flag('top', '5'));

if (!token || !bookSlug || !Number.isInteger(top) || top < 1) {
  process.stderr.write('usage: STORYFORGE_TOKEN=<token> node plugin.mjs --book <book-slug> [--url <address>] [--top <n>]\n');
  process.exit(2);
}

/** GET one API v1 path with the token. */
async function api(path) {
  const res = await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`${path}: ${res.status} ${detail.message ?? detail.error ?? ''}`.trim());
  }
  return res.json();
}

// short and very common English words say little about a chapter
const SKIP = new Set('about after again also been before being could does down from have here into just like more most much must only other over said same some than that their them then there these they this those through very what when where which while will with would your'.split(' '));

/** word -> count for one text; words are lower-case letters (and inner apostrophes), at least 4 long, not in SKIP. */
function count(text, into) {
  for (const w of text.toLowerCase().matchAll(/[a-z]+(?:'[a-z]+)*/g)) {
    if (w[0].length >= 4 && !SKIP.has(w[0])) into.set(w[0], (into.get(w[0]) ?? 0) + 1);
  }
}

try {
  const { books } = await api('/books');
  const book = books.find((b) => b.slug === bookSlug);
  if (!book) throw new Error(`no book "${bookSlug}" was granted to this token`);
  const tree = await api(`/books/${encodeURIComponent(book.slug)}`);
  process.stdout.write(`${tree.title}\n`);
  for (const act of tree.acts) {
    for (const chapter of act.chapters) {
      const counts = new Map();
      for (const scene of chapter.scenes) count((await api(`/books/${encodeURIComponent(book.slug)}/scenes/${encodeURIComponent(scene.id)}`)).body, counts);
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
      process.stdout.write(`\n${act.label} / ${chapter.label}${chapter.title ? `: ${chapter.title}` : ''}\n`);
      for (const [word, n] of ranked) process.stdout.write(`  ${String(n).padStart(3)}  ${word}\n`);
      if (ranked.length === 0) process.stdout.write('  (no words)\n');
    }
  }
} catch (e) {
  process.stderr.write(`word-frequency: ${e.message}\n`);
  process.exit(1);
}
