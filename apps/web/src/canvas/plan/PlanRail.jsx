// The plan part of the canvas page's left rail (M10 C4): plan layers with counts, the structure picker, the what-if branch and the plan-check findings.
// The layers, structure and branch only choose what the board shows; nothing here writes a file.
import { LAYERS, activeStructure, findingOnCanvas, planCounts } from './selectors.js';

/**
 * @param {{ plan: any, layers: Record<string, boolean>, onLayers: (next: Record<string, boolean>) => void, structureId: string | null, onStructure: (id: string) => void,
 *   branch: string | null, onBranch: (branch: string | null) => void, onFinding: (finding: any) => void, onCanvas?: Set<string> | null }} props
 *   `branch` null is the main plan; `onCanvas` the ref ids of the cards on the open canvas (a finding with none of them says so).
 */
export function PlanRail({ plan, layers, onLayers, structureId, onStructure, branch, onBranch, onFinding, onCanvas = null }) {
  const counts = planCounts(plan, structureId);
  const structures = plan?.structures?.structures ?? [];
  const chosen = activeStructure(plan?.structures, structureId);
  const findings = plan?.findings ?? [];
  const branches = plan?.branches ?? [];
  return (
    <div className="cv-plan-rail">
      {plan?.error && (
        <p className="error" role="alert">
          {`Some plan data could not be read (${plan.error}).`}
        </p>
      )}
      <section aria-labelledby="cv-rail-layers">
        <h2 id="cv-rail-layers" className="cv-rail-h">
          Plan layers
        </h2>
        <ul className="cv-rail-layers">
          {LAYERS.map((l) => (
            <li key={l.key}>
              <button type="button" className="cv-layer-btn" aria-pressed={layers[l.key] !== false} onClick={() => onLayers({ ...layers, [l.key]: layers[l.key] === false })}>
                <span className="cv-layer-dot" style={{ background: l.color }} aria-hidden="true" />
                <span className="cv-layer-name">{l.label}</span>
                <span className="cv-layer-count">{plan?.loading ? '…' : counts[l.key]}</span>
              </button>
            </li>
          ))}
        </ul>
        {structures.length > 0 && (
          <div className="cv-rail-field">
            <label htmlFor="cv-rail-structure">Structure</label>
            <select id="cv-rail-structure" value={chosen?.id ?? ''} onChange={(e) => onStructure(e.target.value)}>
              {structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {`${s.name}${s.primary ? ' (Primary)' : ''}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section aria-labelledby="cv-rail-branch">
        <h2 id="cv-rail-branch" className="cv-rail-h">
          Branch
        </h2>
        <div role="radiogroup" aria-labelledby="cv-rail-branch" className="cv-rail-branches">
          {[{ value: null, label: 'Main plan' }, ...branches.map((b) => ({ value: b, label: b }))].map((o) => (
            <label key={o.value ?? 'main'} className="cv-rail-radio">
              <input type="radio" name="cv-branch" checked={(branch ?? null) === o.value} onChange={() => onBranch(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="cv-rail-check">
        <h2 id="cv-rail-check" className="cv-rail-h">
          Plan check <span className="cv-layer-count">{plan?.loading ? '…' : findings.length}</span>
        </h2>
        {!plan?.loading && findings.length === 0 && <p className="muted">No plan problems found.</p>}
        <ul className="cv-rail-findings">
          {findings.map((f, i) => (
            <li key={`${f.rule}:${f.subject?.id ?? ''}:${i}`}>
              <button type="button" className="cv-finding" onClick={() => onFinding(f)}>
                <span className="cv-finding-code">{f.rule}</span>
                <span className="cv-finding-line">{f.title ?? f.message}</span>
              </button>
              {!findingOnCanvas(f, onCanvas) && <span className="cv-finding-off muted">Not on this canvas</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
