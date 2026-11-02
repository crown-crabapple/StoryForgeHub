// Markdown output: LF, UTF-8, no BOM, one trailing newline; the same files and options always give the same bytes.

/** "Chapter One: The Drowned Rows", or just the label when the chapter has no title. @param {{ label: string, title: string }} c */
export const chapterHeading = (c) => (c.title !== '' ? `${c.label}: ${c.title}` : c.label);

/** "Act 1: Low Water". @param {{ label: string, title?: string }} p */
export const partHeading = (p) => (p.title ? `${p.label}: ${p.title}` : p.label);

/** @param {import('./manuscript.mjs').Manuscript} m @returns {Buffer} */
export function renderMarkdown(m) {
  /** @type {string[]} */
  const blocks = [];
  if (m.options.titlePage) {
    if (m.title !== '') blocks.push(`# ${m.title}`);
    if (m.subtitle !== '') blocks.push(`*${m.subtitle}*`);
    if (m.author !== '') blocks.push(`by ${m.author}`);
  }
  for (const part of m.parts) {
    if (m.options.includeActs) blocks.push(`# ${partHeading(part)}`);
    for (const chapter of part.chapters) {
      blocks.push(`## ${chapterHeading(chapter)}`);
      chapter.scenes.forEach((scene, i) => {
        if (m.options.sceneTitles) {
          if (scene.title !== '') blocks.push(`### ${scene.title}`);
        } else if (i > 0) {
          blocks.push('* * *');
        }
        if (scene.markdown !== '') blocks.push(scene.markdown);
      });
    }
  }
  return Buffer.from(`${blocks.join('\n\n')}\n`, 'utf8');
}
