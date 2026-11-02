import { useEffect, useState } from 'react';
import { postJson } from './api.js';
import { Dialog } from './shell/Dialog.jsx';
import { useWrites } from './shell/writes.jsx';

const describe = (a) => (a.kind === 'rename' ? `Rename ${a.from} → ${a.to}` : `Renumber chapter ${a.chapter}`);

/** Shows what a repair would do for each book. Nothing runs until Apply is pressed. */
export function RepairDialog({ books, onClose }) {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const { track } = useWrites();

  useEffect(() => {
    let stop = false;
    Promise.all(
      books.map(async (b) => {
        const res = await fetch(`/api/books/${encodeURIComponent(b.book_id)}/repair/plan`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`Could not plan the repair (${res.status})`);
        return { book: b, plan: await res.json() };
      }),
    ).then(
      (list) => !stop && setPlans(list),
      (e) => !stop && setError(e.message),
    );
    return () => {
      stop = true;
    };
    // the plan is read once, when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const work = (plans ?? []).filter((p) => p.plan.actions.length > 0);

  async function apply() {
    setBusy(true);
    const out = [];
    for (const { book, plan } of work) {
      try {
        const { status, json } = await track(book.book_id, () => postJson(`/api/books/${encodeURIComponent(book.book_id)}/repair`, { actions: plan.actions }));
        out.push({ book, ok: status === 200, text: status === 200 ? 'Repaired.' : `Not repaired: ${json?.message ?? json?.code ?? status}` });
      } catch {
        out.push({ book, ok: false, text: 'Not repaired: the server could not be reached.' });
      }
    }
    setResults(out);
    setBusy(false);
  }

  return (
    <Dialog label="Repair" onClose={onClose}>
        <h2>Repair</h2>
        {error && <p className="error">{error}</p>}
        {!plans && !error && <p className="muted">Looking at the books...</p>}
        {plans &&
          plans.map(({ book, plan }) => (
            <div key={book.book_id}>
              <h3>{book.title ?? (book.path || 'Book')}</h3>
              {plan.actions.length === 0 && plan.unrepairable.length === 0 && <p className="muted">Nothing to repair.</p>}
              {plan.actions.length > 0 && (
                <ul>
                  {plan.actions.map((a) => (
                    <li key={describe(a)}>{describe(a)}</li>
                  ))}
                </ul>
              )}
              {plan.unrepairable.length > 0 && (
                <>
                  <p>These files cannot be repaired automatically:</p>
                  <ul>
                    {plan.unrepairable.map((d) => (
                      <li key={`${d.code}-${d.file}-${d.location}`}>
                        {d.explanation ?? `${d.file}: ${d.message}`} <strong>Fix this file by hand.</strong>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {(results ?? [])
                .filter((r) => r.book === book)
                .map((r) => (
                  <p key={r.text} className={r.ok ? 'muted' : 'error'}>
                    {r.text}
                  </p>
                ))}
            </div>
          ))}
        <p className="status-actions">
          <button type="button" className="btn btn-primary" onClick={apply} disabled={busy || work.length === 0 || results !== null}>
            Apply
          </button>{' '}
          <button type="button" className="btn" onClick={onClose}>
            {results ? 'Close' : 'Cancel'}
          </button>
        </p>
      </Dialog>
  );
}
