import { useState } from 'react';
import { useEditorBridge } from '../editor/bridge.jsx';
import { countWords } from '../editor/wordcount.js';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { useWrites } from '../shell/writes.jsx';
import { STATUSES, bookUrl, explainFailure, send } from '../structure/helpers.js';
import { useWriting } from './WritingContext.jsx';

const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The "Scene" section: status and POV (changed through the structure commands, one front-matter line each), the summary,
 * the live word count, when the scene was last saved and its file path with a copy button.
 * @param {{ book: any, scene: any, objects?: any[] | null, onChanged?: () => void }} props
 */
export function SceneSection({ book, scene, objects = null, onChanged }) {
  const bridge = useEditorBridge();
  const { editor } = useWrites();
  const { liveBody } = useWriting();
  // a choice shows at once; it gives way to the scene's own value as soon as that changes (the book was reloaded)
  const [pending, setPendingState] = useState({ status: null, pov: null });
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const front = scene.front_matter ?? {};
  const own = { status: scene.status ?? '', pov: scene.pov ?? front.pov ?? '' };
  const setPending = (fn) => setPendingState((p) => fn(p));
  const shown = (field) => (pending[field] !== null && pending[field].base === own[field] ? pending[field].value : own[field]);
  const status = shown('status');
  const pov = shown('pov');
  const characters = (objects ?? []).filter((o) => o.kind === 'entry' && o.type === 'character' && typeof o.slug === 'string');
  const povKnown = characters.some((o) => o.slug === pov);
  const words = typeof liveBody === 'string' ? countWords(liveBody) : scene.word_count;

  async function change(field, value) {
    setError(null);
    setPending((p) => ({ ...p, [field]: { value, base: own[field] } }));
    const open = bridge.current();
    if (open && open.sceneId === scene.id) {
      const { saved } = await open.flush();
      if (!saved) {
        setPending((p) => ({ ...p, [field]: null }));
        setError('Not changed: the scene has text that could not be saved yet.');
        return;
      }
    }
    const { status: code, json } = await send(bookUrl(book.id, `/scenes/${encodeURIComponent(scene.id)}/fields`), { [field]: value });
    if (code === 200) onChanged?.();
    else {
      setPending((p) => ({ ...p, [field]: null }));
      setError(explainFailure(code, json));
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(scene.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The path could not be copied. Select it and copy it by hand.');
    }
  }

  return (
    <InspectorSection title="Scene">
      <dl className="scene-facts">
        <div>
          <dt>
            <label htmlFor="rail-status">Status</label>
          </dt>
          <dd>
            <select id="rail-status" value={status} onChange={(e) => change('status', e.target.value)}>
              {status === '' && <option value="">No status</option>}
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div>
          <dt>
            <label htmlFor="rail-pov">POV</label>
          </dt>
          <dd>
            <select id="rail-pov" value={pov} onChange={(e) => change('pov', e.target.value)}>
              {!povKnown && <option value={pov}>{pov === '' ? 'No POV' : pov}</option>}
              {characters.map((o) => (
                <option key={o.id} value={o.slug}>
                  {o.title ?? o.slug}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div>
          <dt>Summary</dt>
          <dd className="scene-summary">{typeof front.summary === 'string' && front.summary !== '' ? front.summary : <span className="muted">No summary.</span>}</dd>
        </div>
        <div>
          <dt>Words</dt>
          <dd>{words}</dd>
        </div>
        <div>
          <dt>Last saved</dt>
          <dd>{editor?.savedAt ? formatTime(editor.savedAt) : <span className="muted">Not changed in this visit</span>}</dd>
        </div>
        <div>
          <dt>File</dt>
          <dd className="scene-path">
            <code>{scene.path}</code>
            <button type="button" className="btn row-button" onClick={copyPath}>
              {copied ? 'Copied' : 'Copy path'}
            </button>
          </dd>
        </div>
      </dl>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </InspectorSection>
  );
}
