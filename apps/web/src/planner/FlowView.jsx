import { Link } from '../router.jsx';
import { sceneHref } from '../planning/model.js';
import { FlowGraph } from './FlowGraph.jsx';
import { LinkPanel } from './LinkPanel.jsx';
import { beatLabel, describeLink, filterNodes, planUrl, sceneName, unlinkedNodes } from './model.js';
import { linksForScene, relationLabel } from './requests.js';

/**
 * The link rows of the list: "<from> — <relation> → <to>", the rationale under it, and Edit and Archive (Restore for an archived one). Real buttons, in reading order.
 * @param {{ links: any[], nodeById: Map<string, any>, selected: string | null, archived?: boolean, handlers: any }} props
 */
function LinkRows({ links, nodeById, selected, archived = false, handlers }) {
  return (
    <ul className="flow-links">
      {links.map((l) => {
        const d = describeLink(l, archived ? null : nodeById);
        return (
          <li key={l.id} className="flow-link-row" aria-current={l.slug === selected ? 'true' : undefined}>
            <span className="flow-sentence">{d.sentence}</span>
            {l.rationale && <p className="flow-rationale muted">{l.rationale}</p>}
            <span className="flow-row-actions">
              {archived ? (
                <button type="button" className="btn btn-small" aria-label={`Restore link: ${d.sentence}`} onClick={() => handlers.onRestore?.(l)}>
                  Restore
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-small" aria-label={`Edit link: ${d.sentence}`} onClick={() => handlers.onSelectLink?.(l.slug)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-small" aria-label={`Archive link: ${d.sentence}`} onClick={() => handlers.onArchive?.(l)}>
                    Archive
                  </button>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The side panel: help, the selected scene (with its Plan section in `scenePlan`), or the selected link. */
function FlowSide({ bookId, url, nodeById, links, linkState, scenePlan, handlers }) {
  const live = links?.links ?? [];
  const found = url.node ? nodeById.get(url.node) : null;
  const node = found && found.kind !== 'beat' ? found : null;
  const link = url.link ? live.find((l) => l.slug === url.link) : null;
  const archivedLink = url.link && !link ? (links?.archived ?? []).find((l) => l.slug === url.link) : null;
  if (url.link && links === null) return <p className="muted">Loading…</p>;
  if (link) {
    return <LinkPanel key={`${link.slug}:${link.sha256}`} link={link} nodeById={nodeById} busy={linkState.busy} message={linkState.message} error={linkState.error} handlers={handlers} />;
  }
  if (archivedLink) {
    const d = describeLink(archivedLink, null);
    return (
      <section className="flow-panel" aria-labelledby="link-panel-h">
        <h2 id="link-panel-h">Archived link</h2>
        <p className="flow-sentence">{d.sentence}</p>
        <button type="button" className="btn" onClick={() => handlers.onRestore?.(archivedLink)}>
          Restore
        </button>
      </section>
    );
  }
  if (url.link) {
    return (
      <section className="flow-panel">
        <h2>Link</h2>
        <p className="muted">That link is not there any more.</p>
      </section>
    );
  }
  if (node) {
    const { outgoing, incoming } = linksForScene(links, node.id);
    return (
      <section className="flow-panel" aria-labelledby="scene-panel-h">
        <h2 id="scene-panel-h">{sceneName(node.title)}</h2>
        <p>
          <Link to={sceneHref(bookId, node.id)}>Open in manuscript</Link>
        </p>
        <p>
          <button type="button" className="btn" onClick={() => handlers.onConnect?.(node.id)}>
            Connect from this scene…
          </button>
        </p>
        <h3 className="plan-links-heading">Links of this scene</h3>
        {outgoing.length + incoming.length === 0 ? (
          <p className="muted">Not linked to other scenes yet.</p>
        ) : (
          <ul className="flow-scene-links">
            {outgoing.map((l) => (
              <li key={l.id}>
                <button type="button" className="btn btn-small" onClick={() => handlers.onSelectLink?.(l.slug)}>
                  {`→ ${relationLabel(l.relation)} ${describeLink(l, nodeById).to}`}
                </button>
              </li>
            ))}
            {incoming.map((l) => (
              <li key={l.id}>
                <button type="button" className="btn btn-small" onClick={() => handlers.onSelectLink?.(l.slug)}>
                  {`${describeLink(l, nodeById).from} ${relationLabel(l.relation)} →`}
                </button>
              </li>
            ))}
          </ul>
        )}
        {scenePlan}
      </section>
    );
  }
  if (url.node) {
    return (
      <section className="flow-panel">
        <h2>Scene</h2>
        <p className="muted">That scene is not in the book any more.</p>
      </section>
    );
  }
  return (
    <section className="flow-panel" aria-labelledby="flow-help-h">
      <h2 id="flow-help-h">Details</h2>
      <p className="muted">Select a scene to see its plan and links, or a link to edit it. Use Connect scenes… to add a link.</p>
    </section>
  );
}

/**
 * The Flow view of the Plan tab: scenes and their causal links as an accessible list and as a graph, with the side panel. Presentational.
 * @param {{ bookId: string, flow: { nodes: any[], edges: any[] } | null, links: { links: any[], archived: any[] } | null, url: ReturnType<typeof import('./model.js').parsePlanSearch>,
 *   wide?: boolean, query?: string, scenePlan?: import('react').ReactNode, linkState?: { busy?: boolean, message?: string | null, error?: string | null },
 *   handlers?: { onQuery?: (q: string) => void, onMode?: (mode: 'list' | 'graph') => void, onConnect?: (from?: string | null) => void, onSelectNode?: (id: string) => void,
 *     onSelectLink?: (slug: string) => void, onOpenBeat?: (node: any) => void, onSave?: Function, onReverse?: Function, onArchive?: Function, onRestore?: Function, onClearFilter?: () => void } }} props
 *   `wide` is true from 768 px up: below that only the list is shown. Without `url.mode` the graph is the default on wide screens.
 */
export function FlowView({ bookId, flow, links, url, wide = true, query = '', scenePlan = null, linkState = {}, handlers = {} }) {
  const allNodes = flow?.nodes ?? [];
  const nodes = allNodes.filter((n) => n.kind !== 'beat');
  const beats = allNodes.filter((n) => n.kind === 'beat');
  const edges = flow?.edges ?? [];
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const live = links?.links ?? [];
  const mode = wide ? (url.mode ?? 'graph') : 'list';
  const unlinkedOnly = url.filter === 'unlinked';
  const unlinked = unlinkedNodes(nodes, live);
  const unlinkedIds = new Set(unlinked.map((n) => n.id));
  const shown = filterNodes(unlinkedOnly ? nodes.filter((n) => unlinkedIds.has(n.id)) : nodes, query);
  const searching = query.trim() !== '';
  const shownBeats = unlinkedOnly ? [] : beats.filter((n) => !searching || beatLabel(n).toLowerCase().includes(query.trim().toLowerCase()));
  const shownIds = new Set([...shown, ...shownBeats].map((n) => n.id));
  const matchesLink = (l) => {
    if (!searching) return true;
    const d = describeLink(l, nodeById);
    return filterNodes([{ title: d.from }, { title: d.to }], query).length > 0;
  };
  const rows = live.filter(matchesLink);
  const archivedRows = (links?.archived ?? []).filter(matchesLink);
  const notLinked = filterNodes(unlinked, query);
  const sceneCount = nodes.length;

  return (
    <div className="plan-flow">
      <div className="flow-toolbar">
        <div className="flow-mode" role="group" aria-label="Show links as">
          <button type="button" className="btn" aria-pressed={mode === 'list'} onClick={() => handlers.onMode?.('list')}>
            List
          </button>
          <button type="button" className="btn" aria-pressed={mode === 'graph'} disabled={!wide} onClick={() => handlers.onMode?.('graph')}>
            Graph
          </button>
        </div>
        <div className="flow-search">
          <label htmlFor="flow-search">Find a scene by title</label>
          <input id="flow-search" type="search" value={query} onChange={(e) => handlers.onQuery?.(e.target.value)} autoComplete="off" />
        </div>
        <button type="button" className="btn btn-primary" onClick={() => handlers.onConnect?.(url.node)} disabled={sceneCount < 2}>
          Connect scenes…
        </button>
      </div>
      {mode === 'graph' && <p className="muted flow-note">The graph is laid out by manuscript order.</p>}
      {!wide && <p className="muted flow-note">The graph needs a screen at least 768 px wide. The list has every link.</p>}
      {unlinkedOnly && (
        <p className="flow-note">
          Showing only scenes that are not linked yet.{' '}
          <Link to={planUrl(bookId, url, { filter: null })}>Show everything</Link>
        </p>
      )}

      <div className="flow-body">
        <div className="flow-main">
          {flow === null || links === null ? (
            <p className="muted">Loading…</p>
          ) : sceneCount === 0 ? (
            <p>
              This book has no scenes yet. Add scenes in the <Link to={`/books/${encodeURIComponent(bookId)}`}>manuscript</Link>, then connect them here.
            </p>
          ) : mode === 'graph' ? (
            <FlowGraph
              nodes={[...shownBeats, ...shown]}
              edges={edges.filter((e) => e.broken || (shownIds.has(e.from) && shownIds.has(e.to)))}
              nodeById={nodeById}
              selectedNode={url.node}
              selectedLink={url.link}
              onSelectNode={handlers.onSelectNode}
              onSelectEdge={handlers.onSelectLink}
              onOpenBeat={handlers.onOpenBeat}
            />
          ) : (
            <>
              {!unlinkedOnly && (
                <section aria-labelledby="flow-links-h" className="plan-block">
                  <h2 id="flow-links-h">Links</h2>
                  {rows.length === 0 ? (
                    <p className="muted">{searching ? 'No link has a scene with that title.' : 'No links yet. Use Connect scenes… to add the first one.'}</p>
                  ) : (
                    <LinkRows links={rows} nodeById={nodeById} selected={url.link} handlers={handlers} />
                  )}
                </section>
              )}
              {!unlinkedOnly && shownBeats.length > 0 && (
                <section aria-labelledby="flow-beats-h" className="plan-block">
                  <h2 id="flow-beats-h">Beats</h2>
                  <ul className="flow-unlinked ln-beat-list">
                    {shownBeats.map((n) => (
                      <li key={n.id}>
                        <button type="button" className="flow-scene-button" onClick={() => handlers.onOpenBeat?.(n)}>
                          {beatLabel(n)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section aria-labelledby="flow-unlinked-h" className="plan-block">
                <h2 id="flow-unlinked-h">Scenes not linked yet</h2>
                {notLinked.length === 0 ? (
                  <p className="muted">{searching ? 'No unlinked scene has that title.' : 'Every scene has at least one link.'}</p>
                ) : (
                  <ul className="flow-unlinked">
                    {notLinked.map((n) => (
                      <li key={n.id} aria-current={n.id === url.node ? 'true' : undefined}>
                        <button type="button" className="flow-scene-button" onClick={() => handlers.onSelectNode?.(n.id)}>
                          {sceneName(n.title)}
                        </button>{' '}
                        <button type="button" className="btn btn-small" aria-label={`Connect ${sceneName(n.title)}`} onClick={() => handlers.onConnect?.(n.id)}>
                          Connect…
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {!unlinkedOnly && (links?.archived ?? []).length > 0 && (
                <details className="plan-block flow-archived">
                  <summary>{`Archived links (${links.archived.length})`}</summary>
                  {archivedRows.length === 0 ? <p className="muted">No archived link has a scene with that title.</p> : <LinkRows links={archivedRows} nodeById={nodeById} selected={url.link} archived handlers={handlers} />}
                </details>
              )}
            </>
          )}
        </div>
        <aside className="flow-side" aria-label="Selected item">
          <FlowSide bookId={bookId} url={url} nodeById={nodeById} links={links} linkState={linkState} scenePlan={scenePlan} handlers={handlers} />
        </aside>
      </div>
    </div>
  );
}
