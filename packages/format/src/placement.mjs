// W201 folder checks for codex entries, threads and events (CONTRACT decision 5).

/**
 * @param {import('./load.mjs').Doc[]} docs documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkPlacement(docs, add) {
  for (const d of docs) {
    const logical = d.archived ? d.rel.slice('archive/'.length) : d.rel;
    if (d.kind === 'entry') {
      const parts = logical.split('/');
      if (parts[0] === 'codex' && parts.length > 2 && typeof d.fm.type === 'string' && parts[1] !== (d.fm.type === 'lore' ? 'lore' : `${d.fm.type}s`)) {
        add('W201', d.file, 'type', `folder codex/${parts[1]} but type=${d.fm.type}`);
      }
    } else if (d.kind === 'thread' && !logical.startsWith('planning/threads/')) {
      add('W201', d.file, 'schema', 'thread file is not under planning/threads/');
    } else if (d.kind === 'continuity-exception' && !logical.startsWith('planning/continuity/')) {
      add('W201', d.file, 'schema', 'continuity exception is not under planning/continuity/');
    } else if (d.kind === 'ai-record' && !logical.startsWith('ai/')) {
      add('W201', d.file, 'schema', 'AI record is not under ai/');
    } else if (d.kind === 'suggestion' && !logical.startsWith('suggestions/')) {
      add('W201', d.file, 'schema', 'suggestion is not under suggestions/');
    } else if (d.kind === 'comment' && !logical.startsWith('comments/')) {
      add('W201', d.file, 'schema', 'comment is not under comments/');
    } else if (d.kind === 'receipt' && !logical.startsWith('provenance/')) {
      add('W201', d.file, 'schema', 'receipt is not under provenance/');
    } else if (d.kind === 'task' && !logical.startsWith('planning/tasks/')) {
      add('W201', d.file, 'schema', 'task is not under planning/tasks/');
    } else if (d.kind === 'event' &&!logical.startsWith('planning/timeline/')) {
      add('W201', d.file, 'schema', 'event file is not under planning/timeline/');
    }
  }
}
