import { useState } from 'react';
import { useApi } from '../api.js';
import { abilities } from '../collab/model.js';
import { sendRequest } from '../continuity/requests.js';
import { AiActivityPanel } from '../insights/AiActivityPanel.jsx';
import { Link, useNavigate } from '../router.jsx';
import { useSession } from '../shared/session.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { statusRequest } from '../tasks/model.js';
import { AiTasksSection, DocsSection, LedgersSection, OverviewSection, SectionNav, StateSection } from './WorkspacePage.jsx';
import {
  STATE_DOCS, aiTasksUrl, archiveDocRequest, castUrl, chapterNumbers, docUrl, docsUrl, explainWorkspaceFailure, findingsUrl, knowledgeUrl, ledgerUrl, levelUrl, lockRequest, overdueThreadIds,
  parseWorkspaceSearch, saveDocRequest, setupRequest, stateAddress, stateEventsUrl, statePrefix, workspaceHref,
} from './model.js';

/**
 * /books/:id/workspace (M12 W8). One page with sections (?section=); each section loads only what it shows. Writes go through the same routes the AI's tools use, so the
 * locks and the sha checks apply to the author too; nothing here is writable for a viewer or reviewer.
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL
 */
export function WorkspaceView({ bookId, search = '' }) {
  const { status } = useStatus();
  const { track } = useWrites();
  const navigate = useNavigate();
  const readOnly = abilities(useSession()).readOnly;
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const url = parseWorkspaceSearch(search);
  const section = url.section;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(/** @type {{ error: boolean, text: string } | null} */ (null));
  const [castChapter, setCastChapter] = useState(/** @type {number | null} */ (null));
  const [eventsChapter, setEventsChapter] = useState(/** @type {number | null} */ (null));
  const [character, setCharacter] = useState(/** @type {string | null} */ (null));
  const [knowledgeAt, setKnowledgeAt] = useState(/** @type {number | null} */ (null));

  const { data: list, error: listError } = useApi(docsUrl(bookId), version);
  const { data: prefs } = useApi(section === 'overview' ? levelUrl(bookId) : null, version);
  const { data: opened } = useApi(section === 'docs' && url.doc ? docUrl(bookId, url.doc) : null, version);
  const { data: castAll } = useApi(section === 'state' || section === 'ledgers' ? castUrl(bookId) : null, version);
  const chapters = chapterNumbers(castAll, list);
  const stateChapter = url.chapter ?? chapters[0] ?? null;
  const stateDocs = STATE_DOCS.map((n) => ({ name: n, addr: stateChapter === null ? null : stateAddress(stateChapter, n) }));
  const live = (/** @type {string | null} */ addr) => (section === 'state' && addr !== null && (list?.docs ?? []).some((d) => d.path === addr) ? docUrl(bookId, addr) : null);
  const s0 = useApi(live(stateDocs[0].addr), version).data;
  const s1 = useApi(live(stateDocs[1].addr), version).data;
  const s2 = useApi(live(stateDocs[2].addr), version).data;
  const s3 = useApi(live(stateDocs[3].addr), version).data;
  const ledgerOn = section === 'ledgers';
  const { data: ledger } = useApi(ledgerOn ? ledgerUrl(bookId) : null, version);
  const { data: findings } = useApi(ledgerOn ? findingsUrl(bookId) : null, version);
  const { data: entriesData } = useApi(ledgerOn ? `/api/books/${encodeURIComponent(bookId)}/codex/entries` : null, version);
  const { data: cast } = useApi(ledgerOn ? castUrl(bookId, castChapter) : null, version);
  const { data: knowledge } = useApi(ledgerOn && character ? knowledgeUrl(bookId, character, knowledgeAt) : null, version);
  const { data: stateEvents } = useApi(ledgerOn ? stateEventsUrl(bookId, eventsChapter) : null, version);
  const { data: tasks } = useApi(section === 'tasks' ? aiTasksUrl(bookId) : null, version);

  if (listError) {
    return (
      <main id="main" tabIndex={-1} className="page error">
        {listError}
      </main>
    );
  }
  if (list === null) {
    return (
      <main id="main" tabIndex={-1} className="page muted">
        Loading&hellip;
      </main>
    );
  }

  /** Send one write, say what happened, and load everything again. */
  async function write(/** @type {{ method: string, url: string, body: unknown }} */ request, /** @type {string} */ done, /** @type {string} */ fail) {
    setBusy(true);
    setNotice(null);
    const { status: st, json } = await track(bookId, () => sendRequest(request));
    setBusy(false);
    setNotice(st === 200 || st === 201 ? { error: false, text: done } : { error: true, text: `${fail}: ${explainWorkspaceFailure(st, json)}` });
    setBump((n) => n + 1);
    return st;
  }
  const errorOf = (/** @type {string} */ s) => (notice?.error && section === s ? notice.text : null);
  const messageOf = (/** @type {string} */ s) => (notice && !notice.error && section === s ? notice.text : null);
  const entries = (entriesData?.entries ?? []).filter((/** @type {any} */ e) => !e.archived && e.type === 'character');
  const stateDocMap = Object.fromEntries(STATE_DOCS.map((n, i) => [n, [s0, s1, s2, s3][i] ?? null]));

  let body;
  if (section === 'docs') {
    body = (
      <DocsSection
        bookId={bookId}
        list={list}
        open={opened ?? null}
        openPath={url.doc}
        readOnly={readOnly}
        busy={busy}
        error={errorOf('docs')}
        message={messageOf('docs')}
        onSave={(text) => opened && write(saveDocRequest(bookId, { path: opened.path, body: text, base_sha256: opened.sha256 }), 'Saved.', 'Not saved')}
        onLock={(locked) => opened && write(lockRequest(bookId, { path: opened.path }, locked), locked ? 'Locked.' : 'Unlocked.', locked ? 'Not locked' : 'Not unlocked')}
        onArchive={async () => {
          if (!opened) return;
          const st = await write(archiveDocRequest(bookId, opened.path), 'Archived. The file is in the archive folder; nothing was deleted.', 'Not archived');
          if (st === 200) navigate(workspaceHref(bookId, { section: 'docs' }));
        }}
      />
    );
  } else if (section === 'state') {
    body = (
      <StateSection
        bookId={bookId}
        chapters={chapters}
        chapter={stateChapter}
        docs={stateDocMap}
        readOnly={readOnly}
        busy={busy}
        error={errorOf('state')}
        message={messageOf('state')}
        onChapter={(n) => navigate(workspaceHref(bookId, { section: 'state', chapter: n }))}
        onLockChapter={(locked) => stateChapter !== null && write(lockRequest(bookId, { prefix: statePrefix(stateChapter) }, locked), locked ? 'Chapter state locked.' : 'Chapter state unlocked.', 'Not changed')}
      />
    );
  } else if (section === 'ledgers') {
    body = (
      <LedgersSection
        bookId={bookId}
        ledger={ledger}
        overdue={overdueThreadIds(findings)}
        chapters={chapters}
        entries={entries}
        cast={cast}
        castChapter={castChapter}
        knowledge={knowledge}
        character={character}
        knowledgeAt={knowledgeAt}
        stateEvents={stateEvents}
        eventsChapter={eventsChapter}
        onCastChapter={setCastChapter}
        onCharacter={setCharacter}
        onKnowledgeAt={setKnowledgeAt}
        onEventsChapter={setEventsChapter}
      />
    );
  } else if (section === 'tasks') {
    body = (
      <AiTasksSection
        bookId={bookId}
        data={tasks}
        readOnly={readOnly}
        busy={busy}
        error={errorOf('tasks')}
        message={messageOf('tasks')}
        onStatus={(t, to) => write(statusRequest(bookId, t.id, to), 'Status changed.', 'Not changed')}
      />
    );
  } else if (section === 'activity') {
    body = <AiActivityPanel bookId={bookId} version={version} readOnly={readOnly} />;
  } else {
    body = (
      <OverviewSection
        level={prefs ? (prefs.effective?.ai?.level ?? null) : null}
        source={prefs?.sources?.['ai.level']}
        list={list}
        readOnly={readOnly}
        busy={busy}
        error={errorOf('overview')}
        message={messageOf('overview')}
        onSetup={() => write(setupRequest(bookId), 'Starter docs created.', 'Not set up')}
      />
    );
  }
  return (
    <main id="main" tabIndex={-1} className="page workspace-page">
      <h1>AI Workspace</h1>
      <p className="muted">
        Everything the AI keeps for this book: docs, chapter state, ledgers, tasks and what it changed. <Link to={`/books/${encodeURIComponent(bookId)}`}>Back to the manuscript</Link>
      </p>
      <SectionNav bookId={bookId} active={section} />
      {body}
    </main>
  );
}
