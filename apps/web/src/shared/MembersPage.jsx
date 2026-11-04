import { useState } from 'react';
import { BOOK_ROLES, NO_ACCESS, accessSummary, booksFromRows, highestRole, rowsFromBooks } from './bookAccess.js';
import { ROLE_WORDS } from './session.jsx';

const INVITE_ROLES = ['editor', 'reviewer', 'viewer'];
const when = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** A link that is shown once, with a Copy button. @param {{ link: { kind: string, url: string }, onDismiss: () => void }} props */
function LinkOnce({ link, onDismiss }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="members-link" aria-label={`New ${link.kind} link`}>
      <p>
        Copy this {link.kind} link now. It is shown only once; StoryForge keeps only a fingerprint of it.
      </p>
      <label htmlFor="members-link-url" className="sr-only">
        {link.kind} link
      </label>
      <input id="members-link-url" type="text" readOnly value={link.url} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn btn-small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link.url);
            setCopied(true);
          } catch {
            setCopied(false); // the field above can still be selected and copied by hand
          }
        }}
      >
        Copy link
      </button>
      <button type="button" className="btn btn-small" onClick={onDismiss}>
        Done
      </button>
      {copied && <span role="status">Copied.</span>}
    </section>
  );
}

/** One select per book: No access / Viewer / Reviewer / Editor. @param {{ books: { id: string, title: string }[], rows: Record<string, string>, who: string, onChange: (rows: Record<string, string>) => void, disabled?: boolean }} props */
function BookRows({ books, rows, who, onChange, disabled = false }) {
  return (
    <ul className="members-list" aria-label={`Books for ${who}`}>
      {books.map((b) => (
        <li key={b.id}>
          {b.title}{' '}
          <select aria-label={`Access to ${b.title} for ${who}`} value={rows[b.id] ?? NO_ACCESS} disabled={disabled} onChange={(e) => onChange({ ...rows, [b.id]: e.target.value })}>
            <option value={NO_ACCESS}>No access</option>
            {BOOK_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_WORDS[r]}
              </option>
            ))}
          </select>
        </li>
      ))}
    </ul>
  );
}

/** Inline panel to change which books one member can open. @param {{ member: any, books: { id: string, title: string }[], busy: boolean, onSave: (books: Record<string, string> | null) => void, onCancel: () => void }} props */
function AccessPanel({ member, books, busy, onSave, onCancel }) {
  const [all, setAll] = useState(!member.books);
  const [rows, setRows] = useState(() => rowsFromBooks(books, member.books));
  const picked = booksFromRows(rows);
  const none = !all && Object.keys(picked).length === 0;
  const name = member.display_name;
  return (
    <section className="members-access" aria-label={`Book access for ${name}`}>
      <fieldset>
        <legend>Books {name} can open</legend>
        <label className="choice">
          <input type="radio" name={`access-${member.user}`} checked={all} disabled={busy} onChange={() => setAll(true)} />
          All books (as {ROLE_WORDS[member.role]})
        </label>
        <label className="choice">
          <input type="radio" name={`access-${member.user}`} checked={!all} disabled={busy} onChange={() => setAll(false)} />
          Only these books
        </label>
      </fieldset>
      {!all && <BookRows books={books} rows={rows} who={name} onChange={setRows} disabled={busy} />}
      {none && (
        <p className="field-hint" role="status">
          Pick at least one book, or choose All books.
        </p>
      )}
      <button type="button" className="btn btn-small btn-primary" disabled={busy || none} onClick={() => onSave(all ? null : picked)}>
        Save access
      </button>
      <button type="button" className="btn btn-small" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

/**
 * Settings, Members (owner only): members and roles, invitations, share links and "Allow AI for members". The server decides what each role may do; this page only asks.
 * @param {{
 *   members: any[], invites: any[], shares: any[], settings: { ai_for_members: boolean }, books: { id: string, title: string }[], currentUserId?: string | null,
 *   link?: { kind: string, url: string } | null, error?: string | null, busy?: boolean,
 *   onRole: (user: string, role: string) => void, onBooks: (user: string, books: Record<string, string> | null) => void, onRemove: (user: string) => void, onInvite: (p: { role: string, days: number, books?: Record<string, string> }) => void, onRevokeInvite: (id: string) => void,
 *   onShare: (p: { book: string, scope: string, days: number }) => void, onRevokeShare: (id: string) => void, onAi: (on: boolean) => void, onDismissLink: () => void,
 * }} props
 */
export function MembersPage({ members, invites, shares, settings, books, currentUserId = null, link = null, error = null, busy = false, onRole, onBooks, onRemove, onInvite, onRevokeInvite, onShare, onRevokeShare, onAi, onDismissLink }) {
  const [inviteRole, setInviteRole] = useState('editor');
  const [inviteDays, setInviteDays] = useState('7');
  const [inviteAll, setInviteAll] = useState(true);
  const [inviteRows, setInviteRows] = useState(() => rowsFromBooks(books, null));
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const invitePicked = booksFromRows(inviteRows);
  const inviteNone = !inviteAll && Object.keys(invitePicked).length === 0;
  const [shareBook, setShareBook] = useState(books[0]?.id ?? '');
  const [shareScope, setShareScope] = useState('read');
  const [shareDays, setShareDays] = useState('30');
  const bookTitle = (id) => books.find((b) => b.id === id)?.title ?? id;
  const liveInvites = invites.filter((i) => i.live);
  const liveShares = shares.filter((s) => s.live);
  const owners = members.filter((m) => m.role === 'owner' && !m.disabled).length;
  const active = members.filter((m) => !m.disabled);

  return (
    <main id="main" tabIndex={-1} className="page members-page">
      <h1>Members and sharing</h1>
      {error && (
        <p role="alert" className="banner banner-danger">
          {error}
        </p>
      )}
      {link && <LinkOnce link={link} onDismiss={onDismissLink} />}

      <section aria-labelledby="members-h">
        <h2 id="members-h">Members</h2>
        <p className="field-hint">A member with only some books cannot see the others. Shared series data can only be changed by members with all books.</p>
        <table className="members-table">
          <caption className="sr-only">People who can sign in, and their roles</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">User name</th>
              <th scope="col">Role</th>
              <th scope="col">Access</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {active.map((m) => {
              const lastOwner = m.role === 'owner' && owners <= 1;
              return (
                <tr key={m.user}>
                  <th scope="row">{m.display_name}</th>
                  <td>{m.username}</td>
                  <td>
                    <select aria-label={`Role of ${m.display_name}`} value={m.role} disabled={busy || lastOwner} onChange={(e) => onRole(m.user, e.target.value)}>
                      {Object.entries(ROLE_WORDS).map(([r, label]) => (
                        <option key={r} value={r}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {m.role === 'owner' ? (
                      'All books (owner)'
                    ) : (
                      <>
                        {accessSummary(m.books)}{' '}
                        <button type="button" className="btn btn-small" disabled={busy} aria-expanded={editing === m.user} aria-label={`Edit access for ${m.display_name}`} onClick={() => setEditing(editing === m.user ? null : m.user)}>
                          Edit access
                        </button>
                        {editing === m.user && (
                          <AccessPanel
                            member={m}
                            books={books}
                            busy={busy}
                            onCancel={() => setEditing(null)}
                            onSave={(map) => {
                              onBooks(m.user, map);
                              setEditing(null);
                            }}
                          />
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn btn-small" disabled={busy || lastOwner} aria-label={`Remove ${m.display_name}`} onClick={() => onRemove(m.user)}>
                      Remove
                    </button>
                    {m.user === currentUserId && <span className="field-hint"> (you)</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="field-hint">Removing a member signs them out at once. The last owner cannot be removed or changed.</p>
      </section>

      <section aria-labelledby="invites-h">
        <h2 id="invites-h">Invitations</h2>
        <form
          className="members-form"
          aria-label="Invite someone"
          onSubmit={(e) => {
            e.preventDefault();
            if (inviteNone) return;
            if (inviteAll) onInvite({ role: inviteRole, days: Number(inviteDays) });
            else onInvite({ role: highestRole(invitePicked) ?? inviteRole, days: Number(inviteDays), books: invitePicked });
          }}
        >
          <fieldset className="field">
            <legend>Books</legend>
            <label className="choice">
              <input type="radio" name="invite-books" checked={inviteAll} onChange={() => setInviteAll(true)} />
              All books
            </label>
            <label className="choice">
              <input type="radio" name="invite-books" checked={!inviteAll} onChange={() => setInviteAll(false)} />
              Only these books
            </label>
            {!inviteAll && <BookRows books={books} rows={inviteRows} who="the new member" onChange={setInviteRows} />}
            {inviteNone && (
              <p className="field-hint" role="status">
                Pick at least one book, or choose All books.
              </p>
            )}
          </fieldset>
          <div className="field">
            <label htmlFor="invite-role">Role{inviteAll ? '' : ' (for all books; off while choosing books)'}</label>
            <select id="invite-role" value={inviteRole} disabled={!inviteAll} onChange={(e) => setInviteRole(e.target.value)}>
              {INVITE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_WORDS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="invite-days">Valid for (days, up to 30)</label>
            <input id="invite-days" type="number" min="1" max="30" value={inviteDays} onChange={(e) => setInviteDays(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || inviteNone}>
            Create invite link
          </button>
        </form>
        {liveInvites.length === 0 ? (
          <p className="field-hint">No open invitations.</p>
        ) : (
          <ul className="members-list" aria-label="Open invitations">
            {liveInvites.map((i) => (
              <li key={i.id}>
                {ROLE_WORDS[i.role]} invitation{i.books ? `, only ${accessSummary(i.books).replace('Only ', '')}` : ''}, valid until {when(i.expires)}
                <button type="button" className="btn btn-small" disabled={busy} aria-label={`Revoke the ${ROLE_WORDS[i.role]} invitation valid until ${when(i.expires)}`} onClick={() => onRevokeInvite(i.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="shares-h">
        <h2 id="shares-h">Share links</h2>
        <p className="field-hint">Anyone with a share link can read that one book, without an account. They cannot change anything.</p>
        <form
          className="members-form"
          aria-label="Share a book"
          onSubmit={(e) => {
            e.preventDefault();
            if (shareBook) onShare({ book: shareBook, scope: shareScope, days: Number(shareDays) });
          }}
        >
          <div className="field">
            <label htmlFor="share-book">Book</label>
            <select id="share-book" value={shareBook} onChange={(e) => setShareBook(e.target.value)}>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="share-scope">What they can do</label>
            <select id="share-scope" value={shareScope} onChange={(e) => setShareScope(e.target.value)}>
              <option value="read">Read only</option>
              <option value="export">Read and download</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="share-days">Valid for (days, up to 90)</label>
            <input id="share-days" type="number" min="1" max="90" value={shareDays} onChange={(e) => setShareDays(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !shareBook}>
            Create share link
          </button>
        </form>
        {liveShares.length === 0 ? (
          <p className="field-hint">No open share links.</p>
        ) : (
          <ul className="members-list" aria-label="Open share links">
            {liveShares.map((s) => (
              <li key={s.id}>
                {bookTitle(s.book)}, {s.scope.includes('export') ? 'read and download' : 'read only'}, until {when(s.expires)}
                <button type="button" className="btn btn-small" disabled={busy} aria-label={`Revoke the share link for ${bookTitle(s.book)} valid until ${when(s.expires)}`} onClick={() => onRevokeShare(s.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ai-h">
        <h2 id="ai-h">AI</h2>
        <div className="field">
          <label className="choice">
            <input type="checkbox" checked={settings.ai_for_members} disabled={busy} onChange={(e) => onAi(e.target.checked)} />
            Allow AI for members
          </label>
          <p className="field-hint">Editors can use the optional AI workshop only when this is on. Reviewers and viewers never can. You, as owner, always can.</p>
        </div>
      </section>
    </main>
  );
}
