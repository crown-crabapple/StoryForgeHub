import { useMemo } from 'react';
import { markdownToDoc } from '@storyforge/format/rich';
import { renderRich } from './render.js';

/** A scene body as formatted prose: headings, emphasis, quotes, lists and scene breaks, with no Markdown syntax showing. Read only. */
export function RichView({ source, doc, showNotes = false }) {
  const parsed = useMemo(() => doc ?? markdownToDoc(source ?? '').doc, [doc, source]);
  return <div className="rich-prose">{renderRich(parsed, { showNotes })}</div>;
}
