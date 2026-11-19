// Settings -> EPUB validation (optional) (M13-J04 section 5). Where the author's own Java and EPUBCheck are, saved per machine (tools.json in the settings folder, never in a book) through
// PUT /api/tools, and "Check setup", which shows GET /api/tools/status. StoryForge never downloads or installs either; the guide says where to get them.
import { useId, useState } from 'react';
import { putJson, useApi } from '../api.js';

/** The request body for the two fields: an empty field clears that setting. @param {string} java @param {string} epubcheckJar */
export const toolsBody = (java, epubcheckJar) => ({ java: java.trim() === '' ? null : java.trim(), epubcheckJar: epubcheckJar.trim() === '' ? null : epubcheckJar.trim() });

/** One tool line of the status: its name, ready or not, the version and the reason. @param {string} name @param {any} tool */
export function toolLine(name, tool) {
  if (!tool || typeof tool !== 'object') return `${name}: not checked`;
  if (tool.state === 'ready') return `${name}: ready${tool.version ? `, version ${tool.version}` : ''}${tool.path ? ` (${tool.path})` : ''}`;
  return `${name}: not ready. ${tool.reason ?? 'It could not be checked.'}`;
}

/** @param {string} what */
const unreachable = (what) => `StoryForge could not be reached, so ${what}.`;

/**
 * The section from what the server answered (also used by tests).
 * @param {{
 *   java: string, epubcheckJar: string, status?: any, message?: string | null, busy?: boolean,
 *   onJava?: (v: string) => void, onJar?: (v: string) => void, onSave?: () => void, onCheck?: () => void
 * }} props `status` is the answer of GET /api/tools/status, or 'checking'.
 */
export function EpubSettingsView({ java, epubcheckJar, status = null, message = null, busy = false, onJava = () => {}, onJar = () => {}, onSave = () => {}, onCheck = () => {} }) {
  const id = useId();
  return (
    <section aria-labelledby="epub-validation-heading" className="pref-section">
      <h2 id="epub-validation-heading">EPUB validation (optional)</h2>
      <p className="muted">
        StoryForge can check an exported EPUB with EPUBCheck, a free tool that tests a file against the EPUB standard. It needs two things you install yourself: Java 8 or newer, and EPUBCheck 5 (tested
        with 5.4.0). StoryForge never downloads or installs them, and the check runs on this computer only. The StoryForge guide (Editing and publishing) says where to get them. Then enter where they
        are below: the whole path to the java program (java.exe on Windows) and to the file epubcheck.jar.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-java`}>Java program (java or java.exe)</label>
          <input id={`${id}-java`} type="text" value={java} onChange={(e) => onJava(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-hint`} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-jar`}>EPUBCheck file (epubcheck.jar)</label>
          <input id={`${id}-jar`} type="text" value={epubcheckJar} onChange={(e) => onJar(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-hint`} />
        </div>
        <p className="secondary field-hint" id={`${id}-hint`}>
          Leave a field empty to let StoryForge look for it: first the STORYFORGE_JAVA and STORYFORGE_EPUBCHECK_JAR settings of your computer, then JAVA_HOME, then the Java on your PATH. EPUBCheck is
          only found if you name it.
        </p>
        <div className="dialog-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCheck}>
            Check setup
          </button>
        </div>
      </form>
      {message && <p role="status">{message}</p>}
      {status === 'checking' && <p role="status">Checking…</p>}
      {status && status !== 'checking' && (
        <ul className="epub-setup-status" aria-label="Setup status">
          <li>{toolLine('Java', status.java)}</li>
          <li>{toolLine('EPUBCheck', status.epubcheck)}</li>
        </ul>
      )}
    </section>
  );
}

/** Settings -> EPUB validation (optional). */
export function EpubSettings() {
  const { data, error } = useApi('/api/tools');
  // what the author typed, or null while the field still shows the saved value
  const [javaEdit, setJava] = useState(/** @type {string | null} */ (null));
  const [jarEdit, setJar] = useState(/** @type {string | null} */ (null));
  const java = javaEdit ?? data?.java ?? '';
  const jar = jarEdit ?? data?.epubcheckJar ?? '';
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [message, setMessage] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await putJson('/api/tools', toolsBody(java, jar));
      if (r.status === 200) {
        setJava(r.json?.java ?? '');
        setJar(r.json?.epubcheckJar ?? '');
        setMessage('Saved.');
      } else setMessage(r.json?.message ?? `Not saved (${r.status}).`);
    } catch {
      setMessage(unreachable('it was not saved'));
    }
    setBusy(false);
  }

  async function check() {
    setBusy(true);
    setMessage(null);
    setStatus('checking');
    try {
      const res = await fetch('/api/tools/status', { headers: { accept: 'application/json' } });
      if (res.ok) setStatus(await res.json());
      else {
        setStatus(null);
        setMessage(`The setup could not be checked (${res.status}).`);
      }
    } catch {
      setStatus(null);
      setMessage(unreachable('the setup was not checked'));
    }
    setBusy(false);
  }

  return <EpubSettingsView java={java} epubcheckJar={jar} status={status} message={message ?? (error ? 'The saved settings could not be read.' : null)} busy={busy} onJava={setJava} onJar={setJar} onSave={save} onCheck={check} />;
}
