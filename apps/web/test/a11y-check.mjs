// Render-level accessibility checks for the M06-J03 audit (not a test file; no dependencies). It reads the static markup React renders on the
// server (no browser) into a small tree and reports what a screen reader or a keyboard user would trip over.
// What it can see: names, labels, landmarks, ids, tab order, heading order. What it cannot: colours, focus rings and layout (see contrast.test.mjs,
// a11y-styles.test.mjs and the manual browser walk).

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

/** Parse markup into { tag, attrs, children, parent } nodes; text nodes are { text }. */
export function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[5] !== undefined) {
      cur.children.push({ text: decode(m[5]), parent: cur });
      continue;
    }
    const [, closing, tagRaw, rawAttrs, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (closing) {
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] === undefined ? '' : decode(a[2]);
    const node = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (!VOID.has(tag) && !selfClose) cur = node;
  }
  return root;
}

export function* walk(node) {
  for (const c of node.children ?? []) {
    if (c.tag) {
      yield c;
      yield* walk(c);
    }
  }
}

const hidden = (n) => {
  for (let x = n; x && x.tag; x = x.parent) if (x.attrs['aria-hidden'] === 'true' || 'hidden' in x.attrs) return true;
  return false;
};

/** Text a screen reader would read inside `node`: text, img alt, svg title; skips aria-hidden parts. */
function textOf(node, byId, seen = new Set()) {
  let out = '';
  for (const c of node.children ?? []) {
    if (!c.tag) {
      out += c.text;
      continue;
    }
    if (c.attrs['aria-hidden'] === 'true' || 'hidden' in c.attrs) continue;
    if (c.tag === 'img') out += ` ${c.attrs.alt ?? ''} `;
    else if (c.tag === 'svg') {
      const t = c.children.find((x) => x.tag === 'title');
      out += c.attrs['aria-label'] ? ` ${c.attrs['aria-label']} ` : t ? ` ${textOf(t, byId, seen)} ` : '';
    } else if (c.attrs['aria-label'] && !['button', 'a'].includes(c.tag)) out += ` ${c.attrs['aria-label']} `;
    else out += ` ${textOf(c, byId, seen)} `;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function indexIds(root) {
  const byId = new Map();
  for (const n of walk(root)) if (n.attrs.id !== undefined) (byId.get(n.attrs.id) ?? byId.set(n.attrs.id, []).get(n.attrs.id)).push(n);
  return byId;
}

/** The accessible name of an element (aria-labelledby, aria-label, a label, its content), or ''. */
export function nameOf(node, byId, root) {
  const lb = node.attrs['aria-labelledby'];
  if (lb) {
    const t = lb.split(/\s+/).map((id) => (byId.get(id)?.[0] ? textOf(byId.get(id)[0], byId) : '')).join(' ').trim();
    if (t) return t;
  }
  if (node.attrs['aria-label']?.trim()) return node.attrs['aria-label'].trim();
  if (['input', 'select', 'textarea', 'meter', 'progress'].includes(node.tag)) {
    const own = [];
    if (node.attrs.id) for (const l of walk(root)) if (l.tag === 'label' && l.attrs.for === node.attrs.id) own.push(textOf(l, byId));
    for (let x = node.parent; x && x.tag; x = x.parent) if (x.tag === 'label') own.push(textOf(x, byId));
    return own.join(' ').trim();
  }
  return textOf(node, byId);
}

const FIELD_SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const ROLE_NAMED = new Set(['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab', 'option', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'searchbox', 'listbox', 'slider', 'dialog', 'img', 'treeitem']);

/**
 * Everything wrong in one page's markup.
 * @param {string} html
 * @param {{ landmarks?: string[], page?: boolean, allowDuplicateNames?: (name: string, tag: string) => boolean }} [opts]
 *   landmarks: any of 'banner' (header), 'navigation' (nav), 'main', 'complementary' (aside) that must be present; page: also require exactly one <main>.
 * @returns {string[]} problems
 */
export function audit(html, { landmarks = [], page = false, allowDuplicateNames = () => false } = {}) {
  const root = parse(html);
  const byId = indexIds(root);
  const problems = [];
  const all = [...walk(root)];
  const where = (n) => `<${n.tag}${n.attrs.class ? ` class="${n.attrs.class}"` : ''}${n.attrs.id ? ` id="${n.attrs.id}"` : ''}>`;

  for (const [id, nodes] of byId) if (nodes.length > 1) problems.push(`duplicate id "${id}" (${nodes.length} elements)`);

  const names = new Map();
  for (const n of all) {
    if (n.attrs.tabindex !== undefined && Number(n.attrs.tabindex) > 0) problems.push(`positive tabindex on ${where(n)}`);
    const role = n.attrs.role;
    const interactive = n.tag === 'button' || (n.tag === 'a' && n.attrs.href !== undefined) || (role && ROLE_NAMED.has(role) && n.tag !== 'ul' && n.tag !== 'li');
    if (n.tag === 'img' && n.attrs.alt === undefined && n.attrs.role !== 'presentation') problems.push(`img without alt: ${n.attrs.src ?? ''}`);
    if (n.tag === 'svg' && n.attrs.role === 'img' && !nameOf(n, byId, root)) problems.push(`svg role=img without a name ${where(n)}`);
    if (interactive && !hidden(n) && !('disabled' in n.attrs && false)) {
      const nm = nameOf(n, byId, root);
      if (!nm) problems.push(`${n.tag}${role ? `[role=${role}]` : ''} without an accessible name: ${where(n)}`);
      else if (n.attrs['aria-label'] !== undefined) {
        const key = `${n.tag}|${nm}`;
        names.set(key, (names.get(key) ?? 0) + 1);
      }
    }
    if (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') {
      if (n.tag === 'input' && FIELD_SKIP.has((n.attrs.type ?? 'text').toLowerCase())) continue;
      if (hidden(n)) continue;
      if (!nameOf(n, byId, root)) problems.push(`${n.tag}${n.attrs.type ? `[type=${n.attrs.type}]` : ''} without a label: ${where(n)}${n.attrs.name ? ` name="${n.attrs.name}"` : ''}`);
    }
    for (const attr of ['aria-describedby', 'aria-labelledby']) {
      if (n.attrs[attr]) for (const id of n.attrs[attr].split(/\s+/)) if (!byId.has(id)) problems.push(`${attr}="${id}" on ${where(n)} points at nothing`);
    }
    if (role === 'dialog' && !nameOf(n, byId, root)) problems.push(`dialog without a name ${where(n)}`);
    if (role === 'dialog' && n.attrs['aria-modal'] !== 'true') problems.push(`dialog without aria-modal ${where(n)}`);
    // an error shown next to a field must be tied to it: a field that says it is invalid names its message
    if (n.attrs['aria-invalid'] === 'true' && !n.attrs['aria-describedby'] && !n.attrs['aria-errormessage']) problems.push(`invalid field without aria-describedby ${where(n)}`);
  }
  for (const [key, count] of names) {
    const [tag, name] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    if (count > 1 && !allowDuplicateNames(name, tag)) problems.push(`${count} <${tag}> elements share the accessible name "${name}"`);
  }

  // headings in order: a heading may be at most one level deeper than the one before it
  let prev = 0;
  for (const n of all) {
    const m = /^h([1-6])$/.exec(n.tag);
    if (!m || hidden(n)) continue;
    const level = Number(m[1]);
    if (prev !== 0 && level > prev + 1) problems.push(`heading jumps from h${prev} to h${level}: "${textOf(n, byId).slice(0, 40)}"`);
    prev = level;
  }

  const has = (pred) => all.some(pred);
  const LANDMARK = { banner: (n) => n.tag === 'header' && !n.parent?.tag?.match(/^(article|section|aside|main)$/), navigation: (n) => n.tag === 'nav', main: (n) => n.tag === 'main', complementary: (n) => n.tag === 'aside' };
  for (const l of landmarks) if (!has(LANDMARK[l])) problems.push(`landmark missing: ${l}`);
  const mains = all.filter((n) => n.tag === 'main');
  const h1s = all.filter((n) => n.tag === 'h1' && !hidden(n));
  if (page && h1s.length !== 1) problems.push(`a page needs exactly one <h1> (found ${h1s.length})`);
  if (page && mains.length !== 1) problems.push(`a page needs exactly one <main> (found ${mains.length})`);
  for (const n of all) if ((n.tag === 'nav' || n.tag === 'aside') && !nameOf(n, byId, root) && all.filter((x) => x.tag === n.tag).length > 1) problems.push(`${n.tag} without a name next to another ${n.tag}`);
  // the skip link must be the first focusable thing and point at the main region
  if (page) {
    const first = all.find((n) => n.tag === 'a' || n.tag === 'button' || n.tag === 'input');
    if (!first || first.attrs.class !== 'skip-link' || first.attrs.href !== '#main') problems.push('the skip link is not the first focusable element');
    if (mains[0] && mains[0].attrs.id !== 'main') problems.push('<main> has no id="main" for the skip link');
  }
  return problems;
}
