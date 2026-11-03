// Optional AI cover drafts (M08-J03 section 3): book -> Cover drafts -> Generate a draft -> edit the prompt -> consent dialog -> Send.
// Nothing is drawn unless the book has an image provider and the ai module is on. The consent dialog names exactly what leaves the computer (the prompt text
// and nothing else), the provider, its host and whether that is this computer. A draft is only a draft until the author chooses "Use as cover".
import { useState } from 'react';
import { useApi } from '../api.js';
import { useModule } from '../prefs/PrefsContext.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { LocalityBadge } from './parts.jsx';
import { aiRequest, aiUrl, problemText } from './requests.js';

/** Step 1: the prompt, prefilled from the book's title, genre and logline. Nothing is sent from here. @param {{ info: any, initial: string, onNext: (prompt: string) => void, onClose: () => void }} props */
export function PromptDialog({ info, initial, onNext, onClose }) {
  const [prompt, setPrompt] = useState(initial);
  const tooLong = prompt.length > info.maxPromptChars;
  return (
    <Dialog label="Write the cover prompt" onClose={onClose} className="ai-cover-prompt">
      <h2>Write the cover prompt</h2>
      <p className="muted">This text describes the picture you want. Nothing is sent until you confirm on the next step.</p>
      <div className="ai-field">
        <label className="ai-label" htmlFor="ai-cover-prompt">
          Prompt
        </label>
        <textarea id="ai-cover-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-invalid={tooLong ? 'true' : undefined} />
        {tooLong && <p className="field-error">The prompt can be at most {info.maxPromptChars} characters.</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" disabled={prompt.trim() === '' || tooLong} onClick={() => onNext(prompt)}>
          Review before sending
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Step 2: the consent dialog. It shows exactly the text that will be sent, to whom, and where that is.
 * @param {{ info: any, prompt: string, sending: boolean, error: string | null, onSend: () => void, onClose: () => void }} props
 */
export function ConsentDialog({ info, prompt, sending, error, onSend, onClose }) {
  const p = info.provider;
  return (
    <Dialog label="Send this prompt to the image provider" onClose={onClose} className="ai-cover-consent">
      <h2>Send this prompt?</h2>
      <p>
        <LocalityBadge locality={p.locality} host={p.host} /> {p.name} · {p.model}
      </p>
      <p>
        This sends <strong>only the text below</strong> to <strong>{p.host}</strong>
        {p.locality === 'cloud' ? ', which is not on this computer' : ', a server on this computer'}. No scene, note, file or other part of your book is sent.
      </p>
      <pre className="ai-selection" aria-label="The exact text that will be sent">
        {prompt}
      </pre>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {sending && <p role="status">Waiting for the provider…</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" disabled={sending} onClick={onSend}>
          Send
        </button>
        <button type="button" className="btn" disabled={sending} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** The drafts of the book, and the entry to making another. @param {{ book: any, info: any, onChanged: () => void, onClose: () => void }} props */
export function CoverDraftsDialog({ book, info, onChanged, onClose }) {
  const [step, setStep] = useState(/** @type {'list' | 'prompt' | 'consent'} */ ('list'));
  const [prompt, setPrompt] = useState(info.prompt);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [note, setNote] = useState(/** @type {string | null} */ (null));

  async function send() {
    setSending(true);
    setError(null);
    try {
      const r = await aiRequest('POST', aiUrl.coverGenerate(book.id), { prompt, consent: true, host: info.provider.host });
      if (r.status === 201) {
        setStep('list');
        setNote('A new draft was added. It is not your cover until you choose "Use as cover".');
        onChanged();
      } else setError(problemText(r));
    } catch {
      setError('The server could not be reached.');
    }
    setSending(false);
  }
  async function use(d) {
    setNote(null);
    const r = await aiRequest('POST', aiUrl.coverUse(book.id), { name: d.name }).catch(() => null);
    if (r?.status === 200) {
      setNote('This draft is now the cover of the book.');
      onChanged();
    } else setNote(r ? problemText(r) : 'The server could not be reached.');
  }
  async function remove(d) {
    if (!window.confirm('Delete this draft? It moves to the trash.')) return;
    setNote(null);
    const r = await aiRequest('POST', aiUrl.coverDelete(book.id), { name: d.name }).catch(() => null);
    if (r?.status === 200) {
      setNote('The draft was moved to the trash.');
      onChanged();
    } else setNote(r ? problemText(r) : 'The server could not be reached.');
  }

  return (
    <>
      <Dialog label="Cover drafts" onClose={onClose} className="ai-cover">
        <h2>Cover drafts</h2>
        <p>
          <LocalityBadge locality={info.provider.locality} host={info.provider.host} /> {info.provider.name} · {info.provider.model}
        </p>
        <p className="muted">Drafts are saved in this book (assets/drafts/) and never replace your cover by themselves.</p>
        {info.drafts.length === 0 ? (
          <p className="muted">No drafts yet.</p>
        ) : (
          <ul className="ai-drafts">
            {info.drafts.map((d) => (
              <li key={d.name}>
                <img src={aiUrl.coverDraft(book.id, d.name)} alt={`Cover draft made ${d.created ?? d.name}`} width="120" />
                <div>
                  <p className="muted">{d.prompt ?? 'No prompt recorded.'}</p>
                  {d.isCover && <p role="status">This is the cover now.</p>}
                  <button type="button" className="btn" disabled={d.isCover} onClick={() => use(d)}>
                    Use as cover
                  </button>{' '}
                  <button type="button" className="btn" disabled={d.isCover} onClick={() => remove(d)}>
                    Delete draft
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {note && <p role="status">{note}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => setStep('prompt')}>
            Generate a draft
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
      {step === 'prompt' && (
        <PromptDialog
          info={info}
          initial={prompt}
          onNext={(p) => {
            setPrompt(p);
            setError(null);
            setStep('consent');
          }}
          onClose={() => setStep('list')}
        />
      )}
      {step === 'consent' && <ConsentDialog info={info} prompt={prompt} sending={sending} error={error} onSend={send} onClose={() => setStep('prompt')} />}
    </>
  );
}

/** The "Cover drafts" button of a book page: drawn only when the ai module is on and the book has an image provider. @param {{ book: any }} props */
export function CoverDraftsButton({ book }) {
  const aiOn = useModule('ai');
  const [bump, setBump] = useState(0);
  const [open, setOpen] = useState(false);
  const { data: info } = useApi(aiOn ? aiUrl.cover(book.id) : null, String(bump));
  if (!aiOn || !info || !info.available) return null;
  return (
    <>
      <p className="ai-header-button">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Cover drafts
        </button>
      </p>
      {open && <CoverDraftsDialog book={book} info={info} onChanged={() => setBump((n) => n + 1)} onClose={() => setOpen(false)} />}
    </>
  );
}
