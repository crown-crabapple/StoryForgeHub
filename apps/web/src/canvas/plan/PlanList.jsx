// List mode of the canvas (M10 C10): the plan as plain headed lists in place of the board. Every item is a button that picks it, so the Inspector shows it; nothing here is a
// custom widget (no role=application), so Tab and Enter or Space are all it takes. The lists come from buildPlanList.

/** One item: a button that picks it. */
function Pick({ item, picked, onPick, children }) {
  const on = picked?.kind === item.kind && picked?.id === item.id;
  return (
    <button type="button" className="cv-plist-pick" aria-pressed={on} onClick={() => onPick({ kind: item.kind, id: item.id, title: item.title })}>
      {children}
    </button>
  );
}

/**
 * @param {{ list: ReturnType<typeof import('./listModel.js').buildPlanList>, picked: { kind: string, id: string } | null, onPick: (ref: { kind: string, id: string, title: string }) => void, loading?: boolean }} props
 *   `picked` is the item the Inspector shows.
 */
export function PlanList({ list, picked, onPick, loading = false }) {
  return (
    <div className="cv-plist" aria-label="Plan as lists">
      {loading && <p className="muted">Loading the plan…</p>}
      <section aria-labelledby="cv-pl-story">
        <h2 id="cv-pl-story">Story plan</h2>
        {list.story ? (
          <>
            <Pick item={{ kind: 'story-plan', id: list.story.id, title: 'Story plan' }} picked={picked} onPick={onPick}>
              {list.story.logline || 'Open the story plan'}
            </Pick>
            {list.story.premise && <p className="cv-plist-line">{list.story.premise}</p>}
            <p className="muted cv-plist-line">{list.primary ? `Primary structure: ${list.primary}` : 'No primary structure set'}</p>
          </>
        ) : (
          <p className="muted">{loading ? '…' : 'There is no story plan yet.'}</p>
        )}
      </section>

      <section aria-labelledby="cv-pl-scenes">
        <h2 id="cv-pl-scenes">{list.structureName ? `Scenes by beat (${list.structureName})` : 'Scenes'}</h2>
        {list.groups.every((g) => g.scenes.length === 0) && list.groups.length <= 1 && <p className="muted">No scenes yet.</p>}
        {list.groups.map((g) => (
          <section key={g.id} aria-labelledby={`cv-pl-beat-${g.id}`}>
            <h3 id={`cv-pl-beat-${g.id}`}>{g.name}</h3>
            {g.scenes.length === 0 ? (
              <p className="muted cv-plist-line">No scenes in this beat.</p>
            ) : (
              <ul className="cv-plist-items">
                {g.scenes.map((s) => (
                  <li key={s.id}>
                    <Pick item={{ kind: 'scene', id: s.id, title: s.title }} picked={picked} onPick={onPick}>
                      <span className="cv-plist-title">{s.title}</span>
                      {s.chapter !== null && <span className="muted">{` · Chapter ${s.chapter}`}</span>}
                    </Pick>
                    {(s.goal || s.turn) && (
                      <p className="cv-plist-line">
                        {s.goal && <span>{`Goal: ${s.goal}`}</span>}
                        {s.goal && s.turn && ' · '}
                        {s.turn && <span>{`Turn: ${s.turn}`}</span>}
                      </p>
                    )}
                    {s.links.length > 0 && (
                      <ul className="cv-plist-links" aria-label={`Links from ${s.title}`}>
                        {s.links.map((l) => (
                          <li key={l.slug}>
                            {l.toId ? (
                              <button type="button" className="cv-plist-link" onClick={() => onPick({ kind: 'scene', id: l.toId, title: l.text })}>
                                {l.text}
                              </button>
                            ) : (
                              l.text
                            )}
                            {l.whatIf && <span className="muted">{' (what-if)'}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </section>

      {list.clues && (
        <section aria-labelledby="cv-pl-clues">
          <h2 id="cv-pl-clues">Clues</h2>
          {list.clues.length === 0 ? (
            <p className="muted">No clues yet.</p>
          ) : (
            <ul className="cv-plist-items">
              {list.clues.map((c) => (
                <li key={c.id}>
                  <Pick item={{ kind: 'clue', id: c.id, title: c.fact }} picked={picked} onPick={onPick}>
                    <span className="cv-plist-title">{c.fact}</span>
                    <span className="muted">{` · ${c.kind}`}</span>
                  </Pick>
                  <p className="cv-plist-line">{`Planted: ${c.planted.length > 0 ? c.planted.join(', ') : 'nowhere yet'} · Revealed: ${c.revealed ?? 'not yet'}`}</p>
                  {c.warn && <p className="warning cv-plist-warn">{`Plan check: ${c.warn}`}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {list.arcs && (
        <section aria-labelledby="cv-pl-arcs">
          <h2 id="cv-pl-arcs">Arcs</h2>
          {list.arcs.length === 0 ? (
            <p className="muted">No character arcs yet.</p>
          ) : (
            <ul className="cv-plist-items">
              {list.arcs.map((a) => (
                <li key={a.id}>
                  <Pick item={{ kind: 'arc', id: a.id, title: a.name }} picked={picked} onPick={onPick}>
                    {a.name}
                  </Pick>
                  {a.summary && <p className="cv-plist-line">{a.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {list.relationships && (
        <section aria-labelledby="cv-pl-rels">
          <h2 id="cv-pl-rels">Relationships</h2>
          {list.relationships.length === 0 ? (
            <p className="muted">No relationships yet.</p>
          ) : (
            <ul className="cv-plist-items">
              {list.relationships.map((r) => (
                <li key={r.id}>
                  <Pick item={{ kind: 'relationship', id: r.id, title: r.name }} picked={picked} onPick={onPick}>
                    {r.name}
                  </Pick>
                  {r.summary && <p className="cv-plist-line">{r.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="cv-pl-syn">
        <h2 id="cv-pl-syn">Synopses</h2>
        {list.synopses.length === 0 ? (
          <p className="muted">No synopses yet.</p>
        ) : (
          <ul className="cv-plist-items">
            {list.synopses.map((s) => (
              <li key={s.id}>
                <Pick item={{ kind: 'synopsis', id: s.id, title: s.title }} picked={picked} onPick={onPick}>
                  {s.title}
                  {s.stale && <span className="muted">{' · stale'}</span>}
                </Pick>
                {s.excerpt && <p className="cv-plist-line">{s.excerpt}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
