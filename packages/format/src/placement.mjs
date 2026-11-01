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
    } else if (d.kind === 'event' && !logical.startsWith('planning/timeline/')) {
      add('W201', d.file, 'schema', 'event file is not under planning/timeline/');
    }
  }
}
