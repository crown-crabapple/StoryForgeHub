// The operations the benchmark measures, in table order: [key, label].
export const OPERATIONS = [
  ['library_open_cold', 'Open the library, cold (new repository)'],
  ['library_open_warm', 'Open the library, warm'],
  ['book_open_cold', 'Open a book, cold (new repository)'],
  ['book_open_warm', 'Open a book, warm'],
  ['scene_open_warm', 'Open a scene, warm'],
  ['search_book', 'Search across the book'],
  ['index_rebuild', 'Full index rebuild'],
  ['reconcile_1_edit', 'Incremental reconcile after 1 outside edit'],
  ['reconcile_50_edits', 'Incremental reconcile after 50 outside edits'],
  ['export_markdown', 'Export Markdown'],
  ['export_docx', 'Export DOCX'],
  ['export_epub', 'Export EPUB'],
  ['export_pdf', 'Export PDF'],
  ['backup', 'Backup (zip)'],
  ['restore', 'Restore (from that zip)'],
  ['validate_library', 'validate() of the library'],
];
