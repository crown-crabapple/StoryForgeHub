// @storyforge/index - rebuildable SQLite projection of a book's Markdown files (FTS5 search, links, mentions).
export { openIndex } from './open-index.mjs';
export { countWords } from './word-count.mjs';
export { ftsQuery, stripForSearch } from './text.mjs';
export { SCHEMA_VERSION, TABLES } from './schema.mjs';
