// Turn the slugs / ids in a scene's front matter into the names authors know (from GET /api/books/:b/objects).

/**
 * @param {{ id: string, kind: string, slug: string | null, title: string | null, type?: string | null }[] | null | undefined} objects
 * @returns {{ nameOf: (ref: string) => string, known: (ref: string) => boolean }}  `nameOf` gives the entry name / thread title for a slug or
 *   id, or the reference itself when it is not known (a name must never be invented).
 */
export function nameIndex(objects) {
  /** @type {Map<string, string>} */
  const byRef = new Map();
  for (const o of objects ?? []) {
    if (!o || typeof o.title !== 'string' || o.title === '') continue;
    if (typeof o.slug === 'string' && o.slug !== '' && !byRef.has(o.slug)) byRef.set(o.slug, o.title);
    if (typeof o.id === 'string' && !byRef.has(o.id)) byRef.set(o.id, o.title);
  }
  return {
    nameOf: (ref) => byRef.get(ref) ?? ref,
    known: (ref) => byRef.has(ref),
  };
}
