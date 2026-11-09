// M12 W8: the AI Workspace tab. Route and module gating, every section rendered from fixture data in the shapes the server sends, a locked doc read-only, the development label,
// and read-only for viewers and reviewers. Render tests, no browser and no network.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
const m = {};
const BOOK = 'salt-orchard';
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (markup) => decode(markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
const flat = (markup) => text(markup).replace(/ ([,.:;)])/g, '$1').replace(/\( /g, '(');
const hrefs = (markup) => [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((x) => decode(x[1]));
const buttons = (markup) => [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((x) => ({ attrs: x[1], text: text(x[2]) }));
const headings = (markup, level) => [...markup.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'g'))].map((x) => text(x[1]));

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of ['/src/workspace/WorkspacePage.jsx', '/src/workspace/model.js', '/src/insights/AiActivityPanel.jsx', '/src/shell/MoreNav.jsx', '/src/routes.js', '/src/prefs/AiLevelSettings.jsx']) {
    Object.assign(m, { [p]: await vite.ssrLoadModule(p) });
  }
});
after(async () => {
  await vite?.close();
});
const page = () => m['/src/workspace/WorkspacePage.jsx'];
const model = () => m['/src/workspace/model.js'];
const render = (Component, props) => renderToStaticMarkup(h(page()[Component], { bookId: BOOK, ...props }));

const docRow = (path, extra = {}) => ({ path, title: path.split('/').pop(), workspace: 'other', chapter: null, locked: false, sha256: 'a'.repeat(64), updated_at: '2026-11-07T10:00:00.000Z', ...extra });
const LIST = {
  docs: [
    docRow('workspace/book', { title: 'Book', workspace: 'book' }),
    docRow('workspace/style', { title: 'Style', workspace: 'style', locked: true }),
    docRow('development/ideas', { title: 'Ideas' }),
    docRow('state/chapter-02/situation', { workspace: 'state', chapter: 2 }),
  ],
  archived: [],
};
const LEDGER = {
  promises: [
    { id: 'p1', slug: 'the-key', title: 'The key will matter', kind: 'promise', status: 'open', open: true, setup_chapters: [1], develop_chapters: [], payoff_chapters: [], setup: ['s1'], develop: [], payoff: [], characters: [] },
    { id: 'p2', slug: 'the-letter', title: 'The letter is read', kind: 'promise', status: 'paid', open: false, setup_chapters: [2], develop_chapters: [], payoff_chapters: [4], setup: ['s2'], develop: [], payoff: ['s4'], characters: [] },
  ],
  questions: [{ id: 'q1', slug: 'who', title: 'Who locked the door?', kind: 'question', status: 'open', open: true, setup_chapters: [3], develop_chapters: [], payoff_chapters: [], setup: ['s3'], develop: [], payoff: [], characters: [] }],
  clues: [{ id: 'c1', slug: 'muddy-boots', fact: 'Muddy boots by the door', kind: 'physical', status: 'planted', planted: ['s3'], planted_chapters: [3], revealed: null, revealed_chapter: null, red_herring: true }],
  counts: {},
};
const FINDINGS = { findings: [{ rule: 'TH2', sources: [{ kind: 'thread', id: 'p1' }, { kind: 'scene', id: 's1' }] }, { rule: 'CF1', sources: [{ kind: 'thread', id: 'p2' }] }] };
const CAST = [
  { scene: 's1', title: 'Arrival', chapter: 1, cast: [{ entry: 'mara', id: 'e1', slug: 'mara', name: 'Mara', role: 'pov' }] },
  { scene: 's2', title: 'Quiet', chapter: 2, cast: [] },
];
const ENTRIES = [{ id: 'e1', slug: 'mara', name: 'Mara', type: 'character' }];
const KNOWLEDGE = { character: { id: 'e1', slug: 'mara', name: 'Mara' }, at: 2, facts: [{ fact: 'door-was-locked', text: 'The door was locked from inside', how: 'learns', chapter: 2, event: 'chapter-2-state', event_id: 'ev1' }] };
const EVENTS = [{ event: 'chapter-2-state', event_id: 'ev1', chapter: 2, subject: { id: 'e1', slug: 'mara', name: 'Mara' }, kind: 'lost', value: 'the key' }];

describe('tab and routes', () => {
  test('AI Workspace is a tab of the workspace module: parsed, linked, shown with the module on and gone with it off', () => {
    const { parseRoute, tabHref, tabModule, tabVisible, MORE_TABS } = m['/src/routes.js'];
    assert.deepEqual(MORE_TABS.find((t) => t.key === 'workspace'), { key: 'workspace', label: 'AI Workspace', path: '/workspace' });
    assert.deepEqual(parseRoute(`/books/${BOOK}/workspace`, '?section=docs'), { name: 'tab', bookId: BOOK, tab: 'workspace' });
    assert.equal(tabHref(BOOK, 'workspace'), `/books/${BOOK}/workspace`);
    assert.equal(tabModule('workspace'), 'workspace');
    assert.equal(tabVisible('workspace', () => true), true);
    assert.equal(tabVisible('workspace', (id) => id !== 'workspace'), false);
    assert.equal(tabVisible('tasks', (id) => id !== 'workspace'), true, 'other tabs are untouched');
  });

  test('the second nav links to it while the module is on (the default)', () => {
    const markup = renderToStaticMarkup(h(m['/src/shell/MoreNav.jsx'].MoreNav, { bookId: BOOK, active: 'workspace' }));
    assert.deepEqual(hrefs(markup), [`/books/${BOOK}/insights`, `/books/${BOOK}/tasks`, `/books/${BOOK}/workspace`]);
    assert.match(markup, /aria-current="page"[^>]*>AI Workspace</);
  });

  test('the section address round-trips and an unknown section is the overview', () => {
    const { workspaceHref, parseWorkspaceSearch } = model();
    assert.equal(workspaceHref(BOOK), `/books/${BOOK}/workspace`);
    assert.deepEqual(parseWorkspaceSearch('?section=docs&doc=workspace%2Fbook'), { section: 'docs', doc: 'workspace/book', chapter: null });
    assert.deepEqual(parseWorkspaceSearch(workspaceHref(BOOK, { section: 'state', chapter: 3 }).split('?')[1] ? `?${workspaceHref(BOOK, { section: 'state', chapter: 3 }).split('?')[1]}` : ''), { section: 'state', doc: null, chapter: 3 });
    assert.equal(parseWorkspaceSearch('?section=nope').section, 'overview');
  });

  test('the section nav lists the six sections as links, the current one marked', () => {
    const markup = render('SectionNav', { active: 'ledgers' });
    assert.deepEqual(text(markup).split(' ').length > 0 && [...markup.matchAll(/<a\b[^>]*>([^<]*)</g)].map((x) => x[1]), ['Overview', 'Docs', 'Chapter state', 'Ledgers', 'AI tasks', 'Suggestions', 'AI Activity']);
    assert.equal([...markup.matchAll(/aria-current="page"/g)].length, 1);
    assert.match(markup, /aria-current="page"[^>]*>Ledgers</);
  });
});

describe('Overview', () => {
  test('shows the level, one line per level, a Settings link and the setup button when a starter doc is missing', () => {
    const markup = render('OverviewSection', { level: 'advisor', source: 'book', list: { docs: [docRow('workspace/book')] } });
    assert.deepEqual(headings(markup, 2), ['Overview']);
    assert.match(flat(markup), /AI level for this book: Advisor, from set for this book/);
    for (const c of m['/src/prefs/AiLevelSettings.jsx'].AI_LEVEL_CHOICES) assert.ok(flat(markup).includes(`${c.label}: ${c.line}`), c.id);
    assert.ok(hrefs(markup).includes('/settings'));
    assert.deepEqual(buttons(markup).map((b) => b.text), ['Set up workspace']);
    assert.match(text(markup), /workspace\/style/);
  });

  test('no setup button once book and style exist, or for a viewer', () => {
    const full = { docs: [docRow('workspace/book'), docRow('workspace/style')] };
    assert.deepEqual(buttons(render('OverviewSection', { level: 'planner', list: full })), []);
    assert.deepEqual(buttons(render('OverviewSection', { level: 'planner', list: { docs: [] }, readOnly: true })), []);
  });
});

describe('Docs', () => {
  const doc = (path, extra = {}) => ({ ...docRow(path), body: `Body of ${path}`, ...extra });

  test('lists workspace and development docs, the development ones labelled as proposals, never canon', () => {
    const markup = render('DocsSection', { list: LIST, open: null });
    assert.deepEqual(headings(markup, 3), ['Workspace docs', 'Development docs', ]);
    assert.ok(text(markup).includes('AI proposals — never canon'));
    assert.ok(hrefs(markup).includes(`/books/${BOOK}/workspace?section=docs&doc=development%2Fideas`));
    assert.ok(!hrefs(markup).some((x) => x.includes('state%2F')), 'state docs are in Chapter state, not here');
    assert.match(text(markup), /Style workspace\/style · locked/);
  });

  test('an open doc is a textarea with Save, Lock and Archive', () => {
    const markup = render('DocsSection', { list: LIST, open: doc('workspace/book'), openPath: 'workspace/book' });
    assert.match(markup, /<textarea[^>]*>Body of workspace\/book<\/textarea>/);
    assert.doesNotMatch(markup, /<textarea[^>]*readOnly/i);
    assert.deepEqual(buttons(markup).map((b) => b.text), ['Save', 'Lock', 'Archive']);
    assert.ok(buttons(markup).every((b) => !/disabled/.test(b.attrs)));
  });

  test('a locked doc is read-only with a lock note, Save is off and the toggle says Unlock', () => {
    const markup = render('DocsSection', { list: LIST, open: doc('workspace/style', { locked: true }), openPath: 'workspace/style' });
    assert.match(markup, /<textarea[^>]*readOnly/i);
    assert.match(text(markup), /This doc is locked/);
    const bs = buttons(markup);
    assert.deepEqual(bs.map((b) => b.text), ['Save', 'Unlock', 'Archive']);
    assert.match(bs[0].attrs, /disabled/);
    assert.doesNotMatch(bs[1].attrs, /disabled/);
    assert.match(bs[2].attrs, /disabled/);
  });

  test('an open development doc carries the label above its text', () => {
    const markup = render('DocsSection', { list: LIST, open: doc('development/ideas'), openPath: 'development/ideas' });
    assert.match(markup, /class="workspace-dev-note">AI proposals — never canon</);
  });

  test('a viewer gets the text and no controls', () => {
    const markup = render('DocsSection', { list: LIST, open: doc('workspace/book'), openPath: 'workspace/book', readOnly: true });
    assert.match(markup, /<textarea[^>]*readOnly/i);
    assert.deepEqual(buttons(markup), []);
  });
});

describe('Chapter state', () => {
  const sd = (name, locked) => ({ ...docRow(`state/chapter-02/${name}`), body: `${name} text`, locked });

  test('a chapter picker and the four state docs with their lock state, and Lock chapter state', () => {
    const docs = { situation: sd('situation', false), characters: sd('characters', false), knowledge: null, inventory: sd('inventory', true) };
    const markup = render('StateSection', { chapters: [1, 2], chapter: 2, docs });
    assert.deepEqual(headings(markup, 2), ['Chapter state']);
    assert.deepEqual(headings(markup, 3), ['Situation', 'Characters', 'Knowledge', 'Inventory']);
    assert.match(markup, /<label[^>]*>Chapter<\/label><select/);
    assert.match(markup, /<option value="2" selected="">Chapter 2<\/option>/);
    const t = text(markup);
    assert.ok(t.includes('situation text') && t.includes('Not written yet.'));
    assert.equal([...markup.matchAll(/Not locked/g)].length, 2);
    assert.equal([...markup.matchAll(/>Locked</g)].length, 1);
    assert.deepEqual(buttons(markup).map((b) => b.text), ['Lock chapter state']);
    assert.ok(hrefs(markup).includes(`/books/${BOOK}/workspace?section=docs&doc=state%2Fchapter-02%2Fsituation`));
  });

  test('with every doc locked the button unlocks; a viewer has no button and no edit links', () => {
    const docs = { situation: sd('situation', true), characters: sd('characters', true), knowledge: sd('knowledge', true), inventory: sd('inventory', true) };
    assert.deepEqual(buttons(render('StateSection', { chapters: [2], chapter: 2, docs })).map((b) => b.text), ['Unlock chapter state']);
    const ro = render('StateSection', { chapters: [2], chapter: 2, docs, readOnly: true });
    assert.deepEqual(buttons(ro), []);
    assert.ok(!hrefs(ro).some((x) => x.includes('section=docs')));
  });

  test('the prefix a chapter lock sends is its folder', () => {
    const { statePrefix, stateAddress, lockRequest } = model();
    assert.equal(statePrefix(2), 'state/chapter-02');
    assert.equal(stateAddress(12, 'knowledge'), 'state/chapter-12/knowledge');
    assert.deepEqual(lockRequest(BOOK, { prefix: statePrefix(2) }, true).body, { prefix: 'state/chapter-02', locked: true });
  });
});

describe('Ledgers', () => {
  const props = { ledger: LEDGER, overdue: new Set(['p1']), chapters: [1, 2, 3, 4], entries: ENTRIES, cast: CAST, castChapter: null, knowledge: KNOWLEDGE, character: 'e1', knowledgeAt: 2, stateEvents: EVENTS, eventsChapter: null };

  test('promises and questions with status, chapters and the overdue flag; thread edits link to the Threads view', () => {
    const markup = render('LedgersSection', props);
    assert.deepEqual(headings(markup, 2), ['Ledgers']);
    assert.deepEqual(headings(markup, 3), ['Promises', 'Questions', 'Clues', 'Cast by chapter', 'Knowledge', 'State events']);
    const rows = [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((x) => [...x[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])));
    assert.deepEqual(rows[1], ['The key will matter', 'open', '1', 'none', 'Overdue']);
    assert.deepEqual(rows[2], ['The letter is read', 'paid', '2', '4', '']);
    assert.deepEqual(rows[4], ['Who locked the door?', 'open', '3', 'none', '']);
    assert.ok(hrefs(markup).includes(`/books/${BOOK}?view=threads&thread=p1`));
  });

  test('clues, cast, knowledge facts with their text and state events', () => {
    const markup = render('LedgersSection', props);
    const t = flat(markup);
    assert.match(t, /Muddy boots by the door \(red herring\) planted 3 none/);
    assert.ok(hrefs(markup).includes(`/books/${BOOK}?scene=s3`));
    assert.match(t, /Arrival \(chapter 1\): Mara \(pov\)/);
    assert.ok(!t.includes('Quiet'), 'a scene with no cast is left out');
    assert.ok(hrefs(markup).includes(`/books/${BOOK}/codex?entry=e1`));
    assert.ok(t.includes('The door was locked from inside (learns, chapter 2)'));
    assert.match(t, /Mara: lost the key \(chapter 2, chapter-2-state\)/);
    assert.match(markup, /<option value="e1" selected="">Mara<\/option>/);
  });

  test('empty and loading states say so', () => {
    const markup = render('LedgersSection', { ...props, ledger: null, cast: [], knowledge: { ...KNOWLEDGE, facts: [] }, stateEvents: [], castChapter: 3, eventsChapter: 3 });
    const t = text(markup);
    assert.ok(t.includes('Loading'));
    assert.ok(t.includes('No cast is set for chapter 3.'));
    assert.ok(t.includes('knows nothing recorded yet'));
    assert.ok(t.includes('No state events in chapter 3.'));
    assert.match(text(render('LedgersSection', { ...props, character: null })), /Pick a character to see what they know\./);
  });

  test('the ledgers have no buttons: they only read, for anyone', () => {
    assert.deepEqual(buttons(render('LedgersSection', props)), []);
  });

  test('overdue ids come from TH2 findings only', () => {
    assert.deepEqual([...model().overdueThreadIds(FINDINGS)], ['p1']);
    assert.deepEqual([...model().overdueThreadIds(null)], []);
  });
});

describe('AI tasks', () => {
  const data = { tasks: [{ id: 't1', title: 'Check the key', status: 'open', for: 'ai' }, { id: 't2', title: 'Fix the date', status: 'done', for: 'ai' }] };

  test('lists the tasks with status buttons', () => {
    const markup = render('AiTasksSection', { data });
    assert.deepEqual(headings(markup, 2), ['AI tasks']);
    assert.ok(hrefs(markup).includes(`/books/${BOOK}/tasks?task=t1`));
    assert.deepEqual(buttons(markup).map((b) => b.text), ['Start', 'Mark done', 'Drop', 'Reopen']);
  });

  test('a viewer sees them without buttons; an empty list says so', () => {
    assert.deepEqual(buttons(render('AiTasksSection', { data, readOnly: true })), []);
    assert.match(text(render('AiTasksSection', { data: { tasks: [] } })), /No task is marked for the AI\./);
  });
});

describe('AI Activity', () => {
  const items = [
    { opId: 'o1', at: '2026-11-07T14:03:00.000Z', actor: { kind: 'plugin', name: 'mcp-claude' }, summary: 'Saved doc workspace/book', undone: false, undoable: true, archivable: false },
    { opId: 'o2', at: '2026-11-07T14:04:00.000Z', actor: { kind: 'plugin', name: 'mcp-claude' }, summary: 'Created scene Dawn', undone: false, undoable: false, archivable: true, target: { kind: 'scene', id: 's9' } },
  ];

  test('the reused panel offers Undo and Archive to an author', () => {
    const markup = renderToStaticMarkup(h(m['/src/insights/AiActivityPanel.jsx'].AiActivityView, { items }));
    assert.deepEqual(headings(markup, 2), ['AI Activity']);
    assert.deepEqual(buttons(markup).map((b) => b.text), ['Undo', 'Archive']);
  });

  test('and neither to a viewer', () => {
    const markup = renderToStaticMarkup(h(m['/src/insights/AiActivityPanel.jsx'].AiActivityView, { items, readOnly: true }));
    assert.deepEqual(buttons(markup), []);
    assert.ok(text(markup).includes('Saved doc workspace/book'));
  });
});

describe('requests', () => {
  test('docs and starters are written through the workspace routes, with the sha the doc was read at', () => {
    const { saveDocRequest, archiveDocRequest, setupRequest, lockRequest, docUrl, aiTasksUrl, castUrl, knowledgeUrl, stateEventsUrl } = model();
    assert.deepEqual(saveDocRequest(BOOK, { path: 'workspace/book', body: 'x', base_sha256: 'abc' }), { method: 'POST', url: `/api/books/${BOOK}/workspace/docs`, body: { path: 'workspace/book', body: 'x', base_sha256: 'abc' } });
    assert.equal(lockRequest(BOOK, { path: 'workspace/book' }, false).url, `/api/books/${BOOK}/workspace/docs/lock`);
    assert.deepEqual(archiveDocRequest(BOOK, 'development/ideas').body, { path: 'development/ideas' });
    assert.equal(setupRequest(BOOK).url, `/api/books/${BOOK}/workspace/setup`);
    assert.equal(docUrl(BOOK, 'workspace/book'), `/api/books/${BOOK}/workspace/docs?path=workspace%2Fbook`);
    assert.equal(aiTasksUrl(BOOK), `/api/books/${BOOK}/tasks?for=ai`);
    assert.equal(castUrl(BOOK, 2), `/api/books/${BOOK}/cast?chapter=2`);
    assert.equal(knowledgeUrl(BOOK, 'e1', 3), `/api/books/${BOOK}/knowledge?character=e1&at=3`);
    assert.equal(stateEventsUrl(BOOK), `/api/books/${BOOK}/state-events`);
  });

  test('a lock and a conflict are explained', () => {
    const { explainWorkspaceFailure } = model();
    assert.match(explainWorkspaceFailure(409, { code: 'LOCKED' }), /locked/);
    assert.match(explainWorkspaceFailure(409, { code: 'CONFLICT' }), /changed since/);
  });
});
