import { useState } from 'react';
import { RULE_IDS, SEVERITY_CHOICES, ruleName, settingsBody, settingsDraft } from './model.js';

/**
 * "Continuity settings": how many chapters a promise or question may stay open (the Promise overdue rule) and, per rule, a severity or Off. Saved to
 * `planning/continuity/settings.md`, a Markdown file the author owns. Only owners and editors see it. Presentational: `onSave(body)` returns nothing; the parent shows `error` / `saved`.
 * @param {{ settings: { exists?: boolean, overdue_chapters: number, severity: Record<string, string> }, busy?: boolean, error?: string | null, saved?: boolean, onSave: (body: { overdue_chapters: number, severity: Record<string, string> }) => void }} props
 */
export function ContinuitySettings({ settings, busy = false, error = null, saved = false, onSave }) {
  const [draft, setDraft] = useState(() => settingsDraft(settings));
  // load again when the file on disk changed (another save, an outside edit)
  const stamp = JSON.stringify([settings.overdue_chapters, settings.severity]);
  const [seen, setSeen] = useState(stamp);
  if (seen !== stamp) {
    setSeen(stamp);
    setDraft(settingsDraft(settings));
  }
  const overdueOk = /^[0-9]{1,3}$/.test(draft.overdue) && Number(draft.overdue) >= 1;
  return (
    <details className="cf-settings">
      <summary>Continuity settings</summary>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!overdueOk) return;
          onSave(settingsBody(draft));
        }}
      >
        <div className="form-row">
          <label>
            <span className="form-label">Promise overdue after (chapters)</span>
            <input type="number" name="overdue_chapters" min="1" max="999" value={draft.overdue} onChange={(e) => setDraft((d) => ({ ...d, overdue: e.target.value }))} aria-invalid={overdueOk ? undefined : 'true'} />
          </label>
          <p className="muted form-hint">A promise or question that is still open this many chapters after its setup is flagged.</p>
          {!overdueOk && (
            <p role="alert" className="error">
              Use a whole number from 1 to 999.
            </p>
          )}
        </div>
        <fieldset className="cf-settings-rules">
          <legend>Severity per rule</legend>
          {RULE_IDS.map((id) => (
            <div key={id} className="form-row">
              <label>
                <span className="form-label">
                  {id} {ruleName(id)}
                </span>
                <select name={`severity-${id}`} value={draft.severity[id] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, severity: { ...d.severity, [id]: e.target.value } }))}>
                  {SEVERITY_CHOICES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </fieldset>
        <p className="muted form-hint">
          Saved in <code>planning/continuity/settings.md</code>, a file you can edit. Off hides a rule's findings; they come back when you switch it on.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {saved && !error && <p role="status">Saved.</p>}
        <div className="dialog-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !overdueOk}>
            Save settings
          </button>
        </div>
      </form>
    </details>
  );
}
