// Small shared pieces of the AI workshop: the locality badge, the context preview, the cloud confirmation and the word diff.
import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { rememberCloud, tokensText } from './model.js';
import { wordDiff } from './diff.js';

/** Where a request would go: "Local" (this computer) or "Cloud" with the host. Shown wherever a request can be sent. @param {{ locality: 'local' | 'cloud', host?: string }} props */
export function LocalityBadge({ locality, host = '' }) {
  return locality === 'local' ? (
    <span className="badge ai-locality" data-locality="local" title="The request goes to a server on this computer">
      Local{host ? ` · ${host}` : ''}
    </span>
  ) : (
    <span className="badge badge-warn ai-locality" data-locality="cloud" title="The request leaves this computer">
      Cloud{host ? ` · ${host}` : ''}
    </span>
  );
}

const INCLUDED = { full: 'whole file', truncated: 'cut to fit the budget', omitted: 'left out (over the budget)' };

/**
 * The exact request that would be sent: where it goes, the token estimate, which files are in, and the messages word for word.
 * Messages are shown as plain text (never interpreted).
 * @param {{ pkg: { provider: { name: string, model: string, baseUrl: string, locality: 'local' | 'cloud' }, tokens: { estimate: number, budget: number },
 *   files: { path: string, tokens: number, included: string }[], messages: { role: string, content: string }[], contextSha256: string } }} props
 */
export function ContextPreview({ pkg }) {
  let host = '';
  try {
    host = new URL(pkg.provider.baseUrl).host;
  } catch {
    // shown without a host
  }
  return (
    <section className="ai-preview" aria-label="Context preview">
      <h3>This is exactly what would be sent</h3>
      <p>
        <LocalityBadge locality={pkg.provider.locality} host={host} /> {pkg.provider.name} · {pkg.provider.model}
      </p>
      <p className="muted">
        About {tokensText(pkg.tokens.estimate)} of the {tokensText(pkg.tokens.budget)} budget.
      </p>
      {pkg.files.length > 0 && (
        <table className="ai-files">
          <caption className="sr-only">Files in the context</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Tokens</th>
              <th scope="col">Included</th>
            </tr>
          </thead>
          <tbody>
            {pkg.files.map((f) => (
              <tr key={f.path} data-included={f.included}>
                <td>{f.path}</td>
                <td>{f.tokens.toLocaleString('en-US')}</td>
                <td>{INCLUDED[f.included] ?? f.included}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details>
        <summary>Messages ({pkg.messages.length})</summary>
        {pkg.messages.map((m, i) => (
          <div key={i} className="ai-message">
            <strong>{m.role}</strong>
            <pre className="ai-message-text">{m.content}</pre>
          </div>
        ))}
      </details>
      <p className="muted ai-hash">Fingerprint {pkg.contextSha256.slice(0, 12)}</p>
    </section>
  );
}

/**
 * Asked every time a cloud send is about to leave the computer, with the host and the size. "Don't ask again" is held in browser memory for this book only.
 * @param {{ bookId: string, host: string, tokens: number, onConfirm: () => void, onCancel: () => void }} props
 */
export function CloudConfirm({ bookId, host, tokens, onConfirm, onCancel }) {
  const [skip, setSkip] = useState(false);
  return (
    <Dialog label="Send to a cloud provider" onClose={onCancel}>
      <h2>Send to a cloud provider?</h2>
      <p>
        This sends about <strong>{tokensText(tokens)}</strong> of your writing to <strong>{host}</strong>, which is not on this computer.
      </p>
      <label className="ai-check">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Don&apos;t ask again for this book until the page is reloaded
      </label>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (skip) rememberCloud(bookId, true);
            onConfirm();
          }}
        >
          Send to {host}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/**
 * The proposed change against the selection, in one unified text with the changed words marked: removed words struck through, added words underlined.
 * Plain text only; nothing the model wrote is interpreted.
 * @param {{ before: string, after: string }} props
 */
export function DiffView({ before, after }) {
  const parts = wordDiff(before, after);
  return (
    <div className="ai-diff" role="group" aria-label="Proposed change">
      <p className="muted ai-diff-legend">
        <del>removed</del> <ins>added</ins>
      </p>
      <pre className="ai-diff-body">
        {parts.map((p, i) =>
          p.type === 'del' ? (
            <del key={i}>{p.text}</del>
          ) : p.type === 'add' ? (
            <ins key={i}>{p.text}</ins>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
