import { useMemo, useState } from 'react';
import { wordDiff } from '../ai/diff.js';
import { hostOf } from '../ai/model.js';
import { CloudConfirm, ContextPreview, LocalityBadge, StreamingReply } from '../ai/parts.jsx';
import { useExchange } from '../ai/useExchange.js';
import { useAi } from '../ai/AiContext.jsx';
import { useModule } from '../prefs/PrefsContext.jsx';
import { Link } from '../router.jsx';
import { planHref } from './requests.js';
import { SYNOPSIS_TYPES, applyHunks, defaultInstruction, proposalHunks, skippedText, targetText, targetValue, typeLabel, wordCount } from './synopsis.js';
import { useSynopsisWrites } from './useSynopsisWrites.js';
import './synopsis.css';

/** The words of one column; changed words are marked (<del> / <ins>), never by colour alone. */
function Words({ parts, empty }) {
  if (parts.length === 0) return <p className="muted">{empty}</p>;
  return (
    <pre className="sy-text">
      {parts.map((p, i) => (p.type === 'del' ? <del key={i}>{p.text}</del> : p.type === 'add' ? <ins key={i}>{p.text}</ins> : <span key={i}>{p.text}</span>))}
    </pre>
  );
}

/**
 * The hunk-by-hunk review of a proposal. Nothing is written until "Save reviewed text"; Cancel throws the proposal away. A hunk the author has not decided keeps the current text.
 * @param {{ current: string, proposed: string, source: 'extract' | 'ai', skipped?: number, busy?: boolean, onSave: (text: string) => void, onCancel: () => void }} props
 */
export function SynopsisReview({ current, proposed, source, skipped = 0, busy = false, onSave, onCancel }) {
  const { segments } = useMemo(() => proposalHunks(current, proposed), [current, proposed]);
  const hunks = segments.filter((s) => s.kind === 'hunk');
  const [accepted, setAccepted] = useState(/** @type {Set<string>} */ (new Set()));
  const [declined, setDeclined] = useState(/** @type {Set<string>} */ (new Set()));
  const decide = (id, yes) => {
    setAccepted((a) => {
      const next = new Set(a);
      if (yes) next.add(id);
      else next.delete(id);
      return next;
    });
    setDeclined((d) => {
      const next = new Set(d);
      if (yes) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const all = (yes) => {
    setAccepted(yes ? new Set(hunks.map((h) => h.id)) : new Set());
    setDeclined(yes ? new Set() : new Set(hunks.map((h) => h.id)));
  };
  const note = skippedText(skipped);
  const result = applyHunks(segments, accepted);
  const canSave = hunks.length > 0 || source === 'extract';
  return (
    <section className="sy-review" aria-labelledby="sy-review-h">
      <h3 id="sy-review-h">{source === 'extract' ? 'Review changes from your plan' : 'Review the AI reply'}</h3>
      <p className="muted">Nothing is saved until you press Save reviewed text. Hunks you do not accept keep your current text.</p>
      {note && <p role="status">{note}.</p>}
      {hunks.length === 0 ? (
        <p role="status">The proposal matches your current text.</p>
      ) : (
        <>
          <div className="sy-bar">
            <button type="button" className="btn btn-small" onClick={() => all(true)}>
              Accept all
            </button>
            <button type="button" className="btn btn-small" onClick={() => all(false)}>
              Decline all
            </button>
            <span role="status">{`${accepted.size} of ${hunks.length} ${hunks.length === 1 ? 'change' : 'changes'} accepted`}</span>
          </div>
          <ol className="sy-hunks" aria-label="Changes">
            {segments.map((s, i) => {
              if (s.kind === 'same') {
                return (
                  <li key={`s${i}`} className="sy-context">
                    <details>
                      <summary>{`${s.lines.length} unchanged ${s.lines.length === 1 ? 'line' : 'lines'}`}</summary>
                      <pre className="sy-text">{s.lines.join('\n')}</pre>
                    </details>
                  </li>
                );
              }
              const parts = wordDiff(s.before.join('\n'), s.after.join('\n'));
              const status = accepted.has(s.id) ? 'accepted' : declined.has(s.id) ? 'declined' : 'pending';
              const n = hunks.indexOf(s) + 1;
              return (
                <li key={s.id} className="sy-hunk" data-status={status} aria-label={`Change ${n}`}>
                  <div className="sy-hunk-head">
                    <strong>{`Change ${n}`}</strong>
                    <span className="sy-chip">{status === 'accepted' ? 'Accepted' : status === 'declined' ? 'Declined' : 'Not decided'}</span>
                  </div>
                  <div className="sy-sides">
                    <div role="group" aria-label={`Current text, change ${n}`}>
                      <h4>Current</h4>
                      <Words parts={parts.filter((p) => p.type !== 'add')} empty="(nothing)" />
                    </div>
                    <div role="group" aria-label={`Proposed text, change ${n}`}>
                      <h4>Proposed</h4>
                      <Words parts={parts.filter((p) => p.type !== 'del')} empty="(nothing)" />
                    </div>
                  </div>
                  <div className="sy-actions">
                    <button type="button" className="btn btn-small btn-primary" aria-pressed={status === 'accepted'} aria-label={`Accept change ${n}`} onClick={() => decide(s.id, true)}>
                      Accept
                    </button>
                    <button type="button" className="btn btn-small" aria-pressed={status === 'declined'} aria-label={`Decline change ${n}`} onClick={() => decide(s.id, false)}>
                      Decline
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <div className="sy-bar">
        <button type="button" className="btn btn-primary" disabled={busy || !canSave} onClick={() => onSave(result)}>
          Save reviewed text
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel review
        </button>
      </div>
    </section>
  );
}

/**
 * "Ask AI": the existing AI workshop, preview first. The reply is shown here and is never saved; "Use as proposal" opens it in the hunk review.
 * @param {{ bookId: string, item: any, hasStory: boolean, onUse: (text: string) => void, onClose: () => void }} props
 */
function AskAi({ bookId, item, hasStory, onUse, onClose }) {
  const { active } = useAi();
  const ex = useExchange(bookId);
  const [instruction, setInstruction] = useState(() => defaultInstruction(item.type, item.target_words));
  const files = [item.path, ...(hasStory ? ['planning/story.md'] : [])];
  const host = hostOf(active?.baseUrl ?? '');
  const reply = typeof ex.result?.reply === 'string' ? ex.result.reply : null;
  return (
    <section className="sy-ai" aria-labelledby="sy-ai-h">
      <h3 id="sy-ai-h">Ask AI</h3>
      <p className="muted">Nothing leaves your computer until you press Send. The reply is shown here only; you decide what to keep.</p>
      <div className="sy-field">
        <label htmlFor="sy-ai-instruction">Instruction</label>
        <textarea
          id="sy-ai-instruction"
          rows={3}
          value={instruction}
          onChange={(e) => {
            setInstruction(e.target.value);
            ex.reset();
          }}
        />
      </div>
      <p className="muted">{`Files sent: ${files.join(', ')}`}</p>
      <div className="sy-bar">
        <button type="button" className="btn" disabled={instruction.trim() === '' || ex.busy} onClick={() => ex.preview({ task: 'chat', files, instruction })}>
          Preview context
        </button>
        <button type="button" className="btn btn-primary" disabled={!ex.pkg || ex.busy} onClick={() => ex.send()}>
          Send
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {ex.busy && !ex.streaming && <p role="status">Working…</p>}
      {ex.streaming && <StreamingReply text={ex.streamText} onCancel={ex.cancel} />}
      {ex.error && (
        <p role="alert" className="error">
          {ex.error}
        </p>
      )}
      {ex.pkg && <ContextPreview pkg={ex.pkg} />}
      {reply !== null && (
        <section className="sy-reply" aria-label="Reply">
          <h4>Reply</h4>
          <p>{ex.pkg && <LocalityBadge locality={ex.pkg.provider.locality} host={host} />}</p>
          <pre className="sy-text">{reply}</pre>
          <button type="button" className="btn btn-primary" onClick={() => onUse(reply)}>
            Use as proposal
          </button>
        </section>
      )}
      {ex.pendingCloud && ex.pkg && <CloudConfirm bookId={bookId} host={host} tokens={ex.pkg.tokens.estimate} onConfirm={() => ex.confirmCloud()} onCancel={ex.cancelCloud} />}
    </section>
  );
}

/** The fields and body of the open synopsis. Edits stay here until Save. */
function SynopsisEditor({ item, writes, onReview, onKeep, onArchive, hasStory, aiOn, state }) {
  const [name, setName] = useState(item.name ?? '');
  const [target, setTarget] = useState(item.target_words == null ? '' : String(item.target_words));
  const [body, setBody] = useState(item.body ?? '');
  const [ask, setAsk] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const targetBad = target.trim() !== '' && targetValue(target) === null;
  const nextTarget = targetValue(target);
  const changed = name.trim() !== (item.name ?? '') || nextTarget !== (item.target_words ?? null) || body !== (item.body ?? '');
  const busy = state.busy;
  async function submit(e) {
    e.preventDefault();
    if (targetBad) return;
    const patch = {};
    if (name.trim() !== (item.name ?? '')) patch.name = name;
    if (nextTarget !== (item.target_words ?? null)) patch.target_words = nextTarget;
    if (body !== (item.body ?? '')) patch.body = body;
    await writes.save(item, patch);
  }
  return (
    <div className="sy-editor">
      {item.stale && (
        <div className="sy-stale" role="status">
          <p>
            <strong>Sources changed</strong> since you last reviewed the plan extract.
          </p>
          <div className="sy-bar">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onReview(setProblem)}>
              Review changes
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onKeep}>
              Keep my text
            </button>
          </div>
        </div>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}{' '}
          {state.conflict && (
            <button type="button" className="btn btn-small" onClick={writes.reload}>
              Reload
            </button>
          )}
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <form onSubmit={submit}>
        <div className="sy-field">
          <label htmlFor="sy-name">Name</label>
          <input id="sy-name" type="text" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="sy-field">
          <label htmlFor="sy-target">Target words</label>
          <input id="sy-target" type="text" inputMode="numeric" value={target} placeholder="No target" autoComplete="off" aria-invalid={targetBad} onChange={(e) => setTarget(e.target.value)} />
          {targetBad && <span className="error">Use a whole number of 1 or more, or leave it empty.</span>}
        </div>
        <div className="sy-field">
          <label htmlFor="sy-body">Text</label>
          <textarea id="sy-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          <span className="muted" role="status">
            {targetText(wordCount(body), nextTarget)}
          </span>
        </div>
        <div className="sy-bar">
          <button type="submit" className="btn btn-primary" disabled={!changed || targetBad || busy}>
            Save
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setProblem(null);
              await onReview(setProblem);
            }}
          >
            Build from plan
          </button>
          {aiOn && (
            <button type="button" className="btn" aria-expanded={ask} onClick={() => setAsk((v) => !v)}>
              Ask AI
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={onArchive}>
            Archive synopsis
          </button>
          {changed && <span className="sy-dirty" role="status">Unsaved changes</span>}
        </div>
      </form>
      {ask && aiOn && <AskAi bookId={writes.bookId} item={item} hasStory={hasStory} onUse={(text) => { setAsk(false); onReview(setProblem, { text, source: 'ai' }); }} onClose={() => setAsk(false)} />}
    </div>
  );
}

/**
 * The Synopsis view of the Plan tab: the list with a New synopsis form, the editor of the selected synopsis with its review of a proposal, and the archived ones.
 * @param {{ bookId: string, list: { synopses: any[], archived: any[] } | null, detail: any | null, detailLoading?: boolean, selected: string | null, hasStory: boolean, structure: any, refresh: () => void, onSelect: (slug: string | null) => void }} props
 */
export function SynopsisView({ bookId, list, detail, detailLoading = false, selected, hasStory, structure, refresh, onSelect }) {
  const writes = { ...useSynopsisWrites({ bookId, structure, refresh }), bookId };
  const aiModule = useModule('ai');
  const ai = useAi();
  const aiOn = aiModule && ai.available;
  const [type, setType] = useState('short');
  const [newName, setNewName] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [createState, setCreateState] = useState({ busy: false, error: null });
  const [review, setReview] = useState(/** @type {{ slug: string, proposed: string, basis: string | null | undefined, source: 'extract' | 'ai', skipped: number } | null} */ (null));
  const newTargetBad = newTarget.trim() !== '' && targetValue(newTarget) === null;
  const item = detail && detail.slug === selected ? detail : null;
  const state = writes.state.slug === selected ? writes.state : { busy: false, error: null, conflict: false, message: null };

  async function create(e) {
    e.preventDefault();
    if (newTargetBad) return;
    setCreateState({ busy: true, error: null });
    const r = await writes.create({ type, name: newName, target_words: targetValue(newTarget) });
    if (r.ok) {
      setCreateState({ busy: false, error: null });
      setNewName('');
      setNewTarget('');
      if (r.slug) onSelect(r.slug);
    } else setCreateState({ busy: false, error: r.message });
  }

  /** Open the review: the plan extract (no `proposal`) or an AI reply. `fail` shows a refusal. */
  async function openReview(fail, proposal) {
    if (!item) return;
    if (proposal) {
      setReview({ slug: item.slug, proposed: proposal.text, basis: undefined, source: 'ai', skipped: 0 });
      return;
    }
    const got = await writes.extract(item.slug);
    if (!got.ok) {
      fail?.(got.message);
      return;
    }
    setReview({ slug: item.slug, proposed: got.text, basis: got.basis, source: 'extract', skipped: got.skipped });
  }

  const items = list?.synopses ?? [];
  const archived = list?.archived ?? [];
  return (
    <div className="sy-view">
      <section aria-labelledby="sy-list-h" className="plan-block">
        <h2 id="sy-list-h">Synopses</h2>
        {list === null ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No synopses yet. Start one below; it can be built from your plan.</p>
        ) : (
          <ul className="sy-list" aria-label="Synopses">
            {items.map((s) => (
              <li key={s.slug} className="sy-item">
                <Link to={planHref(bookId, { view: 'synopsis', synopsis: s.slug })} aria-current={s.slug === selected ? 'page' : undefined}>
                  <strong>{s.name || typeLabel(s.type)}</strong>
                </Link>{' '}
                <span className="muted">{typeLabel(s.type)}</span> <span>{targetText(s.words ?? 0, s.target_words)}</span>
                {s.stale && <span className="badge badge-warn sy-badge">Sources changed</span>}
              </li>
            ))}
          </ul>
        )}
        <form className="sy-new" onSubmit={create} aria-label="New synopsis">
          <h3>New synopsis</h3>
          <div className="sy-field">
            <label htmlFor="sy-new-type">Type</label>
            <select id="sy-new-type" value={type} onChange={(e) => setType(e.target.value)}>
              {SYNOPSIS_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sy-field">
            <label htmlFor="sy-new-name">Name (optional)</label>
            <input id="sy-new-name" type="text" value={newName} placeholder={typeLabel(type)} autoComplete="off" onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div className="sy-field">
            <label htmlFor="sy-new-target">Target words (optional)</label>
            <input id="sy-new-target" type="text" inputMode="numeric" value={newTarget} autoComplete="off" aria-invalid={newTargetBad} onChange={(e) => setNewTarget(e.target.value)} />
            {newTargetBad && <span className="error">Use a whole number of 1 or more, or leave it empty.</span>}
          </div>
          {createState.error && (
            <p className="error" role="alert">
              {createState.error}
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={createState.busy || newTargetBad}>
            New synopsis
          </button>
        </form>
      </section>

      {selected && (
        <section aria-labelledby="sy-edit-h" className="plan-block">
          <h2 id="sy-edit-h">{item ? `${item.name || typeLabel(item.type)} (${typeLabel(item.type)})` : 'Synopsis'}</h2>
          {!item ? (
            detailLoading ? (
              <p className="muted">Loading…</p>
            ) : (
              <p className="muted">That synopsis is not here. It may be archived or removed.</p>
            )
          ) : (
            <>
              <SynopsisEditor
                key={`${item.slug}:${item.sha256}`}
                item={item}
                writes={writes}
                state={state}
                hasStory={hasStory}
                aiOn={aiOn}
                onReview={(fail, proposal) => openReview(fail, proposal)}
                onKeep={() => writes.keepMyText(item)}
                onArchive={() => writes.archive(item, { onArchived: () => onSelect(null) })}
              />
              {review && review.slug === item.slug && (
                <SynopsisReview
                  key={`${item.sha256}:${review.source}:${review.basis ?? ''}:${review.proposed.length}`}
                  current={item.body ?? ''}
                  proposed={review.proposed}
                  source={review.source}
                  skipped={review.skipped}
                  busy={state.busy}
                  onCancel={() => setReview(null)}
                  onSave={async (text) => {
                    const ok = await writes.save(item, { body: text, ...(review.source === 'extract' && typeof review.basis === 'string' ? { basis: review.basis } : {}) }, 'Reviewed text saved.');
                    if (ok) setReview(null);
                  }}
                />
              )}
            </>
          )}
        </section>
      )}

      {archived.length > 0 && (
        <section aria-labelledby="sy-archived-h" className="plan-block">
          <h2 id="sy-archived-h">Archived synopses</h2>
          <ul className="sy-list">
            {archived.map((s) => (
              <li key={s.slug} className="sy-item">
                <span>{s.name || typeLabel(s.type)}</span> <span className="muted">{typeLabel(s.type)}</span>{' '}
                <button type="button" className="btn btn-small" aria-label={`Restore ${s.name || typeLabel(s.type)}`} onClick={() => writes.restore(s, { onRestored: (slug) => onSelect(slug) })}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
