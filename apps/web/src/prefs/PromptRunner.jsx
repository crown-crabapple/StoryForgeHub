// Run a custom prompt component or workflow (M07-J04 contract section 6). The prompt files live in <library>/_prompts/. For every step: choose the inputs, press
// "Preview context" (the server lists each scene, entry, thread and note it would send, with bytes and a token estimate), read it, and only then press Send.
// A workflow is a list of such steps: the reply of one becomes {{previous}} of the next, and each step is previewed and sent on its own. A rewrite comes back as a
// suggestion (a diff); nothing is applied unless the author asks.
import { useState } from 'react';
import { useApi } from '../api.js';
import { hostOf } from '../ai/model.js';
import { CloudConfirm, ContextPreview, DiffView, LocalityBadge } from '../ai/parts.jsx';
import { aiRequest, aiUrl, problemText } from '../ai/requests.js';
import { useExchange } from '../ai/useExchange.js';
import { continuityHref } from '../continuity/model.js';
import { useNavigate } from '../router.jsx';
import { Dialog } from '../shell/Dialog.jsx';

/** The inputs the form has to collect, by the prompt's declared `inputs`. */
const PICKED = ['entries', 'threads', 'notes'];

/**
 * @param {{ book: any, active: any, records: boolean, scene: { id: string, title: string, path: string } | null,
 *   selection: { sceneId: string, from: number, to: number, text: string } | null, onClose: () => void }} props
 */
export function PromptRunner({ book, active, scene, selection, onClose }) {
  const ex = useExchange(book.id);
  const navigate = useNavigate();
  const { data: library, error: loadError } = useApi('/api/prompts');
  const { data: objects } = useApi(`/api/books/${encodeURIComponent(book.id)}/objects?kinds=entry,thread`);
  const { data: notes } = useApi(`/api/books/${encodeURIComponent(book.id)}/notes`);
  const [choice, setChoice] = useState('');
  const [step, setStep] = useState(0);
  const [previous, setPrevious] = useState('');
  const [picked, setPicked] = useState(/** @type {Record<string, string[]>} */ ({ entries: [], threads: [], notes: [] }));
  const [working, setWorking] = useState(false);
  const [applied, setApplied] = useState(false);
  const host = hostOf(active.baseUrl);

  const prompts = (library?.prompts ?? []).filter((p) => p.problems.length === 0);
  const workflows = (library?.workflows ?? []).filter((w) => w.problems.length === 0);
  const workflow = choice.startsWith('workflow:') ? (workflows.find((w) => w.slug === choice.slice(9)) ?? null) : null;
  const slug = workflow ? workflow.steps[step] : choice.startsWith('prompt:') ? choice.slice(7) : null;
  const prompt = slug ? (prompts.find((p) => p.slug === slug) ?? null) : null;
  const entryOptions = (objects ?? []).filter((o) => o.kind === 'entry');
  const threadOptions = (objects ?? []).filter((o) => o.kind === 'thread');
  const noteOptions = (notes?.notes ?? []).filter((n) => !n.archived);
  const optionsFor = { entries: entryOptions, threads: threadOptions, notes: noteOptions };
  const labelOf = (kind, o) => (kind === 'notes' ? (o.title ?? o.id) : (o.title ?? o.name ?? o.slug ?? o.id));
  const refOf = (kind, o) => (kind === 'notes' ? o.id : (o.slug ?? o.id));

  const needsSelection = prompt?.inputs.includes('selection') ?? false;
  const missingPick = prompt ? PICKED.find((k) => prompt.inputs.includes(k) && picked[k].length === 0) : null;
  const blocker = !prompt
    ? 'Choose a prompt or a workflow.'
    : needsSelection && !selection
      ? 'This prompt works on selected text: close this window, select some text in the editor and run it again.'
      : !scene && (prompt.inputs.includes('scene') || prompt.inputs.includes('chapter') || prompt.inputs.includes('pov-entry'))
        ? 'Open a scene first.'
        : missingPick
          ? `Pick at least one of: ${missingPick}.`
          : null;

  const edit = (fn) => {
    fn();
    ex.reset();
    setApplied(false);
  };

  const spec = () => ({
    ...(workflow ? { workflow: workflow.slug, step } : { slug }),
    previous,
    inputs: {
      ...(scene ? { sceneId: scene.id } : {}),
      ...(selection ? { selection: { sceneId: selection.sceneId, from: selection.from, to: selection.to } } : {}),
      entries: picked.entries,
      threads: picked.threads,
      notes: picked.notes,
    },
  });

  async function preview() {
    // the server fills the placeholders and lists exactly what it would send; nothing leaves this computer yet
    await ex.preview({ prompt: spec() });
  }

  async function apply() {
    setWorking(true);
    try {
      const r = await aiRequest('POST', aiUrl.apply(book.id), { contextId: ex.pkg.contextId });
      if (r.status === 200) setApplied(true);
      else ex.setError(problemText(r));
    } catch {
      ex.setError('The server could not be reached.');
    }
    setWorking(false);
  }

  async function closeAndDiscard() {
    if (ex.pkg && !ex.result) await aiRequest('POST', aiUrl.discard(book.id), { contextId: ex.pkg.contextId }).catch(() => {});
    onClose();
  }

  function nextStep() {
    setPrevious(ex.result?.reply ?? '');
    setStep((n) => n + 1);
    ex.reset();
    setApplied(false);
  }

  const result = ex.result;
  const lastStep = !workflow || step >= workflow.steps.length - 1;
  const rewriteResult = result?.replacement ?? null;
  const sourceRows = (ex.pkg?.sources ?? []).map((s) => ({ ...s, file: s.path ? ex.pkg.files.find((f) => f.path === s.path) : null }));

  return (
    <Dialog label="Run a prompt" onClose={closeAndDiscard} className="ai-rewrite prompt-runner">
      <h2>Run a prompt</h2>
      <p>
        <LocalityBadge locality={active.locality} host={host} /> {active.name} · {active.model}
      </p>
      {loadError && <p className="error">{loadError}</p>}
      {library && prompts.length === 0 && workflows.length === 0 && (
        <p className="muted">There are no prompts yet. Add a Markdown file to the _prompts folder of your library (see docs/customization.md).</p>
      )}
      <div className="ai-field">
        <label className="ai-label" htmlFor="prompt-choice">
          Prompt or workflow
        </label>
        <select
          id="prompt-choice"
          value={choice}
          onChange={(e) =>
            edit(() => {
              setChoice(e.target.value);
              setStep(0);
              setPrevious('');
            })
          }
        >
          <option value="">Choose…</option>
          {prompts.length > 0 && (
            <optgroup label="Prompts">
              {prompts.map((p) => (
                <option key={p.slug} value={`prompt:${p.slug}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {workflows.length > 0 && (
            <optgroup label="Workflows">
              {workflows.map((w) => (
                <option key={w.slug} value={`workflow:${w.slug}`}>
                  {w.name} ({w.steps.length} steps)
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {workflow && (
        <p role="status" className="muted">
          Step {step + 1} of {workflow.steps.length}: {prompt?.name ?? slug}. Every step is previewed and sent on its own.
        </p>
      )}

      {prompt && (
        <section aria-label="Inputs">
          <h3>What this prompt reads</h3>
          <ul className="ai-chosen">
            {prompt.inputs.includes('selection') && <li>The selected text{selection ? ` (${selection.text.length} characters)` : ': none selected'}</li>}
            {prompt.inputs.includes('scene') && <li>The open scene{scene ? `: ${scene.title}` : ''}</li>}
            {prompt.inputs.includes('chapter') && <li>Every scene of the open scene&apos;s chapter</li>}
            {prompt.inputs.includes('pov-entry') && <li>The Codex entry of the scene&apos;s point of view</li>}
          </ul>
          {PICKED.filter((k) => prompt.inputs.includes(k)).map((kind) => (
            <fieldset key={kind} className="field">
              <legend>{kind === 'entries' ? 'Codex entries' : kind === 'threads' ? 'Plot threads' : 'Research notes'}</legend>
              {optionsFor[kind].length === 0 && <p className="muted">None in this book.</p>}
              {optionsFor[kind].map((o) => (
                <label key={o.id} className="ai-check">
                  <input
                    type="checkbox"
                    checked={picked[kind].includes(refOf(kind, o))}
                    onChange={(e) =>
                      edit(() => setPicked((p) => ({ ...p, [kind]: e.target.checked ? [...p[kind], refOf(kind, o)] : p[kind].filter((x) => x !== refOf(kind, o)) })))
                    }
                  />{' '}
                  {labelOf(kind, o)}
                </label>
              ))}
            </fieldset>
          ))}
        </section>
      )}

      {ex.pkg && !result && (
        <>
          <section className="ai-preview" aria-label="Sources">
            <h3>These sources will be sent</h3>
            <p className="muted">
              {ex.pkg.prompt?.name}
              {ex.pkg.prompt?.workflow ? ` (step ${ex.pkg.prompt.step + 1} of ${ex.pkg.prompt.steps})` : ''}
            </p>
            <table className="ai-files">
              <caption className="sr-only">Sources of this prompt</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">File</th>
                  <th scope="col">Bytes</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((s, i) => (
                  <tr key={`${s.input}-${s.path ?? i}`}>
                    <td>{s.label}</td>
                    <td>{s.path ?? 'text you selected'}</td>
                    <td>{s.file ? s.file.bytes.toLocaleString('en-US') : ''}</td>
                    <td>{s.file ? s.file.tokens.toLocaleString('en-US') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <ContextPreview pkg={ex.pkg} />
        </>
      )}

      {result && (
        <section aria-label="Reply">
          <h3>{rewriteResult ? 'Proposed rewrite' : 'Reply'}</h3>
          {rewriteResult ? <DiffView before={ex.pkg?.selection?.text ?? selection?.text ?? ''} after={rewriteResult} /> : <pre className="ai-message-text">{result.reply}</pre>}
          {applied && <p role="status">Applied to the scene.</p>}
          {rewriteResult && !applied && result.suggestion && <p className="muted">Saved as a suggestion: the scene is unchanged until you accept a change.</p>}
        </section>
      )}

      {(ex.busy || working) && <p role="status">Working…</p>}
      {ex.error && (
        <p role="alert" className="form-error">
          {ex.error}
        </p>
      )}
      {blocker && !result && <p className="muted">{blocker}</p>}

      <div className="dialog-actions">
        {!result && (
          <>
            <button type="button" className="btn" disabled={blocker !== null || ex.busy} onClick={preview}>
              Preview context
            </button>
            <button type="button" className="btn btn-primary" disabled={!ex.pkg || ex.busy} onClick={() => ex.send({})}>
              Send
            </button>
          </>
        )}
        {result && rewriteResult && !applied && !result.suggestion && (
          <button type="button" className="btn" disabled={working} onClick={apply}>
            Apply
          </button>
        )}
        {result && rewriteResult && result.suggestion && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose();
              navigate(continuityHref(book.id, { suggestion: result.suggestion.id }));
            }}
          >
            Review changes
          </button>
        )}
        {result && workflow && !lastStep && (
          <button type="button" className="btn btn-primary" onClick={nextStep}>
            Next step
          </button>
        )}
        <button type="button" className="btn" onClick={closeAndDiscard}>
          {result ? 'Done' : 'Cancel'}
        </button>
      </div>
      {ex.pendingCloud && ex.pkg && <CloudConfirm bookId={book.id} host={host} tokens={ex.pkg.tokens.estimate} onConfirm={() => ex.confirmCloud({})} onCancel={ex.cancelCloud} />}
    </Dialog>
  );
}
