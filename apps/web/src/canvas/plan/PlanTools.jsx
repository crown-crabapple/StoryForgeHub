// The plan tools of the canvas toolbar (M10 C8): Cause, Clue, Arc, Relationship and Beat. Each one makes the plan item with the planner's own writes, then puts a card for it on the canvas
// (a column for a beat). The dialogs and the write hooks live here so the board stays small; the new item's id is found in the plan data once it has been read again.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api.js';
import { CLUE_KINDS } from '../../planner/clues.js';
import { NewArcDialog } from '../../planner/ArcsView.jsx';
import { NewRelationshipDialog } from '../../planner/RelationshipEditor.jsx';
import { entriesUrl } from '../../planner/requests.js';
import { useArcWrites } from '../../planner/useArcWrites.js';
import { useClueWrites } from '../../planner/useClueWrites.js';
import { useRelationshipWrites } from '../../planner/useRelationshipWrites.js';
import { useStructureWrites } from '../../planner/useStructureWrites.js';
import { Dialog } from '../../shell/Dialog.jsx';
import { useStructure } from '../../structure/useStructure.jsx';
import { activeStructure } from './selectors.js';

/** The plan tools in toolbar order: [tool, label, glyph]. */
export const PLAN_TOOLS = [
  ['cause', 'Cause', '⇢'],
  ['clue', 'Clue', '?'],
  ['arc', 'Arc', '∿'],
  ['relationship', 'Relationship', '⇄'],
  ['beat', 'Beat', '▥'],
];

/** The id of the item waited for in the plan data, or null while it is not there yet. @param {any} w @param {{ structures: any, clues: any[] | undefined, arcs: any[] | undefined, relationships: any[] | undefined }} data */
function newItemId(w, data) {
  if (w.kind === 'beat') {
    const fresh = (activeStructure(data.structures, w.structureId)?.beats ?? []).filter((b) => typeof b?.id === 'string' && !w.known.has(b.id));
    return (fresh.find((b) => (b.name ?? '') === w.name) ?? fresh[0])?.id ?? null;
  }
  const items = w.kind === 'clue' ? data.clues : w.kind === 'arc' ? data.arcs : data.relationships;
  return (items ?? []).find((x) => x?.slug === w.slug)?.id ?? null;
}

const idOf = (x) => (typeof x === 'string' ? x : typeof x?.id === 'string' ? x.id : null);

/** How long a created item is waited for in the re-read plan before the author is told. */
const WAIT_MS = 15000;

/**
 * Buttons (after a separator) and dialogs of the plan tools.
 * @param {{ bookId: string, plan: any, structureId?: string | null, connecting: boolean, onCause: () => void,
 *   onAddCard: (kind: 'clue' | 'arc' | 'relationship' | 'beat', id: string) => void, onProblem: (message: string | null) => void }} props
 *   `onCause` switches the board to its connect tool; `onAddCard(kind, id)` puts the card (or beat column) for the plan item `id` on the canvas.
 */
export function PlanTools({ bookId, plan, structureId = null, connecting, onCause, onAddCard, onProblem }) {
  const book = useMemo(() => ({ id: bookId }), [bookId]);
  const refresh = plan?.refresh ?? (() => {});
  const structure = useStructure({ book, activeId: null, onChanged: refresh });
  const clueWrites = useClueWrites({ bookId, structure, refresh });
  const arcWrites = useArcWrites({ bookId, structure, refresh });
  const relationshipWrites = useRelationshipWrites({ bookId, structure, refresh });
  const structureWrites = useStructureWrites({ bookId, structure, refresh });
  const [dialog, setDialog] = useState(/** @type {'clue' | 'arc' | 'relationship' | 'beat' | null} */ (null));
  const entries = useApi(dialog === 'arc' || dialog === 'relationship' ? entriesUrl(bookId) : null, 0);
  // the item just created that is waited for: { kind, slug } or, for a beat, { kind: 'beat', structureId, known: Set of the beat ids before, name }
  const waiting = useRef(/** @type {any} */ (null));
  const timer = useRef(/** @type {any} */ (null));
  const stopWaiting = () => {
    waiting.current = null;
    clearTimeout(timer.current);
  };
  const startWaiting = (w) => {
    stopWaiting();
    waiting.current = w;
    timer.current = setTimeout(() => {
      waiting.current = null;
      onProblem('The new item was made, but it could not be found in the plan to add its card. Add it with a story card.');
    }, WAIT_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const active = activeStructure(plan?.structures, structureId);
  const arcs = plan?.arcs?.arcs;
  const relationships = plan?.relationships?.relationships;
  const clues = plan?.clues?.clues;

  // find the new item once the plan has been read again, then add its card
  useEffect(() => {
    const w = waiting.current;
    if (!w) return;
    const id = newItemId(w, { structures: plan?.structures, clues, arcs, relationships });
    if (id) {
      stopWaiting();
      onAddCard(w.kind, id);
    }
  }, [plan?.structures, clues, arcs, relationships]); // eslint-disable-line react-hooks/exhaustive-deps -- runs when the plan data is read again; the waited-for item is in a ref

  const entryList = (entries.data ?? []).filter((o) => o.kind === 'entry' && typeof o.slug === 'string');
  const characters = entryList.filter((o) => o.type === 'character').map((o) => ({ id: o.id, slug: o.slug, title: o.title }));
  const allEntries = entryList.map((o) => ({ id: o.id, slug: o.slug, title: o.title, type: o.type }));

  function open(tool) {
    onProblem(null);
    if (tool === 'cause') onCause();
    else setDialog(tool);
  }

  async function createBeat(v) {
    if (!active) return { ok: false, message: 'There is no story structure yet. Start one in the rail first.' };
    const beats = (active.beats ?? []).map((b) => ({ ...b, scenes: (b.scenes ?? []).map(idOf).filter(Boolean) }));
    const name = v.name.trim();
    const next = [...beats, { name, ...(v.position.trim() ? { position: v.position } : {}), ...(v.question.trim() ? { question: v.question } : {}), state: 'open', scenes: [] }];
    const ok = await structureWrites.handlersFor(active).onSaveBeats(next);
    if (!ok) return { ok: false, message: structureWrites.state.error ?? structureWrites.state.message ?? 'The beat was not saved.' };
    startWaiting({ kind: 'beat', structureId: active.id, known: new Set(beats.map((b) => b.id).filter(Boolean)), name });
    return { ok: true };
  }

  return (
    <>
      <span className="cv-tool-sep" role="separator" aria-orientation="vertical" />
      {PLAN_TOOLS.map(([t, label, glyph]) => (
        <button key={t} type="button" className="cv-tool cv-tool-labeled" aria-label={label} aria-pressed={t === 'cause' ? connecting : undefined} title={t === 'cause' ? 'Cause: connect two scenes with a Flow link' : `New ${label.toLowerCase()}`} onClick={() => open(t)}>
          <span aria-hidden="true">{glyph}</span>
          <span className="cv-tool-label">{label}</span>
        </button>
      ))}
      {dialog === 'clue' && (
        <ClueDialog
          onClose={() => setDialog(null)}
          onCreate={async (v) => {
            const r = await clueWrites.create(v);
            if (r.ok) {
              setDialog(null);
              if (r.slug) startWaiting({ kind: 'clue', slug: r.slug });
            }
            return r;
          }}
        />
      )}
      {dialog === 'arc' && (
        <NewArcDialog
          characters={characters}
          hasArc={new Set((arcs ?? []).map((a) => a.character_id))}
          onCreate={async (id) => {
            const r = await arcWrites.create({ character: id });
            if (r.ok) {
              setDialog(null);
              if (r.slug) startWaiting({ kind: 'arc', slug: r.slug });
            }
            return r;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'relationship' && (
        <NewRelationshipDialog
          entries={allEntries}
          onCreate={async (a, b) => {
            const r = await relationshipWrites.create({ a, b });
            if (r.ok) {
              setDialog(null);
              if (r.slug) startWaiting({ kind: 'relationship', slug: r.slug });
            }
            return r;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'beat' && (
        <BeatDialog
          structureName={active?.name ?? null}
          onClose={() => setDialog(null)}
          onCreate={async (v) => {
            const r = await createBeat(v);
            if (r.ok) setDialog(null);
            return r;
          }}
        />
      )}
      {structure.ui}
    </>
  );
}

/** A clue's fact and kind. `onCreate` returns `{ ok: true }` (the container closes the dialog) or `{ ok: false, message }`. */
function ClueDialog({ onCreate, onClose }) {
  const [fact, setFact] = useState('');
  const [kind, setKind] = useState('clue');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  async function submit(e) {
    e.preventDefault();
    if (fact.trim() === '') {
      setProblem('Say what the clue is.');
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await onCreate({ fact, kind });
    setBusy(false);
    if (r && r.ok === false) setProblem(r.message);
  }
  return (
    <Dialog label="New clue" onClose={onClose}>
      <h2>New clue</h2>
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="cv-new-clue-fact">Fact</label>
          <textarea id="cv-new-clue-fact" rows={3} value={fact} onChange={(e) => setFact(e.target.value)} required />
        </div>
        <div className="form-row">
          <label htmlFor="cv-new-clue-kind">Kind</label>
          <select id="cv-new-clue-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {CLUE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {`${k.label}: ${k.words}`}
              </option>
            ))}
          </select>
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Start clue
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A beat's name, with its position and question when wanted. */
function BeatDialog({ structureName, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  async function submit(e) {
    e.preventDefault();
    if (name.trim() === '') {
      setProblem('Give the beat a name.');
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await onCreate({ name, position, question });
    if (!alive.current) return;
    setBusy(false);
    if (r && r.ok === false) setProblem(r.message);
  }
  return (
    <Dialog label="New beat" onClose={onClose}>
      <h2>New beat</h2>
      {structureName && <p className="muted">{`It goes at the end of “${structureName}”.`}</p>}
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="cv-new-beat-name">Name</label>
          <input id="cv-new-beat-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
        </div>
        <div className="form-row">
          <label htmlFor="cv-new-beat-position">Position (optional)</label>
          <input id="cv-new-beat-position" type="text" value={position} onChange={(e) => setPosition(e.target.value)} autoComplete="off" />
        </div>
        <div className="form-row">
          <label htmlFor="cv-new-beat-question">Question (optional)</label>
          <input id="cv-new-beat-question" type="text" value={question} onChange={(e) => setQuestion(e.target.value)} autoComplete="off" />
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Add beat
          </button>
        </div>
      </form>
    </Dialog>
  );
}
