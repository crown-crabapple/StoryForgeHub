# M07-J03 contract — optional self-hosted shared mode

Binding: DECISIONS 1, 5, 6, 7, 9, 11, 12; FEATURE-REGISTER F17 ("optional server layer retains file authority"); M01-J01 app boundary (write guard header, 127.0.0.1); M05-J06 suggestions; M05-J07 receipts; M07-J01.

**Personal mode does not change.** No accounts, no login, `127.0.0.1` only, the same routes and the same files. Shared mode is opt-in per run (`serve --shared`). It adds identity, roles and review on top of **the same library folder**. Nothing canonical moves into a server database, and nothing is hosted elsewhere.

Split:
- **J03a**: identity, sessions, roles, invitations, shares, audit, route policy. The coordinator writes the security core (§2–§4) personally.
- **J03b**: comments, reviewer mode, presence, conflict-preserving saves, attribution, UI. Depends on J03a.

## 1. Running shared mode

- Command: `serve --shared [--shared-data <dir>] [--host <addr>] [--public-url <https://…>]`.
- `--shared-data` defaults to `<config>/shared/<library-hash>/`. It is never inside the library, so a book backup never contains accounts.
- `--host` other than `127.0.0.1`/`::1` is refused without `--shared`.
- With a non-loopback host and no `--public-url https://…`, the server starts but prints a warning: "use a TLS reverse proxy".
- Cookies are `Secure` when `--public-url` is https.
- `shared init --owner <username>` creates the shared data. It prints a **one-time setup link** for the owner to set a password. The link is valid 30 minutes, and only its token hash is stored.
- No email is ever sent; links are shown to the person creating them.

## 2. Identity and sessions (coordinator-written)

**Users** — `users.json` in shared data:
- Fields: `{ id: usr_<ULID>, username, display_name, pw: { alg: 'scrypt', N: 32768, r: 8, p: 1, salt, hash }, created, disabled }`.
- `username`: `^[a-z0-9][a-z0-9._-]{2,31}$`, unique case-insensitively.
- Password rules: length 10–256, not equal to the username.

**Login** — `POST /api/auth/login { username, password }`:
- The same `401` body and timing shape for an unknown user and a wrong password. A dummy scrypt runs for unknown users.
- Rate limit: 5 failures per username per 15 minutes, and 20 per remote address per 15 minutes. Then `429`.

**Sessions:**
- Token: 32 random bytes, base64url, sent in the cookie `sf_session`.
- Cookie flags: `HttpOnly`, `SameSite=Strict`, `Path=/`, plus `Secure` per §1.
- The server stores only `sha256(token)` in `sessions.json`, with `{ user, created, last_seen, expires }`.
- Expiry: 14 days idle, 30 days absolute.
- Logout deletes it.
- A password change, user disable, or member removal deletes **all** that user's sessions.

**Writes** (all of these must hold):
- the existing `x-storyforge` header guard;
- `SameSite=Strict`;
- an `Origin` check: same origin as `--public-url`, or as the request host when none is set.

**Shared-data files:**
- Written through `@storyforge/store` atomic writes. The folder gets mode 0700 where the OS supports it.
- A corrupt file → the server refuses to start in shared mode, with a clear message. It never silently resets.

## 3. Roles and route policy (coordinator-written)

- `members.json`: `[{ user, role }]`. `role` is one of `owner`, `editor`, `reviewer`, `viewer`.
- There is exactly one or more owners. The last owner cannot be removed or demoted.

**Every API route is classified** in one table, `apps/server/src/policy.mjs`:

| Class | Who | Examples |
|---|---|---|
| `read` | viewer+ | GET book, scene, codex, insights, export download |
| `comment` | reviewer+ | create, reply or resolve a comment |
| `suggest` | reviewer+ | create a suggestion (`source: reviewer`) |
| `write` | editor+ | save a scene, structure commands, codex/planning edits, accept/decline a suggestion, tasks |
| `ai` | editor+ and the `ai` module on and the owner allowed AI for members | AI send |
| `admin` | owner | members, invites, shares, AI settings, backup/restore, open library, repair `--apply` |

- Unclassified route → **denied** (`403`) in shared mode. A test enumerates the router's routes and fails on any unclassified one.
- Personal mode skips the policy; it has a single implicit owner.
- Viewers and reviewers get the same JSON for reads. The UI hides controls by role; the server is the authority.

## 4. Invitations, shares and audit

**Invites:**
- The owner creates `{ role (not owner), expires (default 7 days, max 30) }` and gets a link with a 32-byte token. The hash is stored in `invites.json`.
- A link is single-use. Accepting it sets username, display name and password, then adds the member.
- Expired or revoked → `410`.

**Shares:**
- A read-only link for **one book**, without an account. Scope: `read` only, or `read` + `export`.
- Expiry is required, max 90 days. It is revocable.
- A share session cannot reach any other book, any admin or write route, or AI.

**Audit:**
- `audit.jsonl` in shared data, append-only.
- Each line: `{ seq, at, actor: usr_… | share_… | system, event, target?, ip?, prev: sha256(prev line) }`.
- Events:
  - auth: login ok/fail (never the password), logout;
  - invites: create, accept, revoke;
  - members: role change, member removed;
  - shares: create, revoke, used;
  - every `write`/`suggest`/`comment`/`admin`/`ai` call: route class, target id, result code.
- `audit verify` CLI checks the chain. It reports `AUDIT_CHAIN_BROKEN` at the first bad line.
- The audit log never contains manuscript text.

## 5. Comments (J03b) — `comments/<YYYY>/<YYYYMMDD-HHMMSS>-<slug>.md` (author data, non-canonical)

```yaml
---
schema: storyforge.comment/v1
id: note_…
target: scene_…
anchor: { line: 14, lines: 1, quote: "her green eyes", sha256: … }   # located like suggestion hunks
status: open             # open | resolved
by: { id: usr_…, name: "Tobin" }   # personal mode: by: { name: <author> }
created: "…"
---
First comment text.

## Reply — Ilse — 2026-11-02T15:00:00Z
Reply text.
```

- Replies are appended sections. Resolve is a single-line edit.
- A target that does not resolve → `W314`. Bad shape → `E102`. Outside `comments/` → `W201`.
- Comments are **never** exported to readers. They **are** in book backups.
- Personal mode can use comments too, as author notes with anchors.

## 6. Reviewer mode, suggestions and attribution (J03b)

**Reviewer mode:**
- Reviewers and viewers see the editor read-only.
- Reviewers can select text → **Comment** or **Suggest change**. Suggest change makes a suggestion with `source: reviewer`, `by`.
- Only editors and owners can accept or decline.

**Attribution:**
- In shared mode, receipts gain an optional `by: { id, name }` (additive within v1, FORMAT §9.4).
- Suggestions and comments carry `by` too.
- The receipts blame view shows the name.

## 7. Simultaneous editing (J03b)

**Presence (advisory):**
- `GET/POST /api/books/:b/presence`: who has which scene open, refreshed by heartbeat every 20 seconds, gone after 60 seconds. Kept in memory.
- The editor shows "Ilse is also in this scene".
- Advisory locks are just presence. They never block a save.

**Stale save:**
- The scene `PUT` already carries the base sha (M03-J02). In shared mode, a save whose base no longer matches the disk → `409 STALE`, with the current text.
- The server writes the stale buffer as a **suggestion** against the current file (`source: author`, `mode: suggest`, `by`, rationale "Saved over a newer version"). **Both versions are kept**, and nothing is lost.
- The editor opens the existing compare view (ConflictPanel). From there the user merges by accepting hunks.

**Offline:** a client that reconnects with a buffer based on an old sha gets the same 409 path.

## 8. Acceptance (J03a + J03b)

1. **Role fixtures** (four users, one per role, plus a share link), for every route class:
   - a viewer can't write, comment or suggest;
   - a reviewer can comment and suggest but cannot save a scene or accept a suggestion;
   - an editor can't reach admin;
   - a share can't leave its book or do anything but read/export.
   - Each refusal leaves every library file unchanged (snapshot).
2. **Auth:**
   - wrong password and unknown user give the same response shape;
   - rate limit;
   - session expiry (fake clock) for idle and absolute;
   - logout and password change kill sessions;
   - a missing header or bad Origin refuses writes;
   - the last owner is protected;
   - expired, revoked and reused invites are refused.
3. **Simultaneous edit:**
   - two editors load the same scene;
   - A saves, then B saves from the old base → B gets `409`;
   - B's text exists as a suggestion, A's text is on disk;
   - accepting B's hunks merges. Nothing is lost at any point.
4. **Export completeness:**
   - after the shared-mode session, a personal-mode export and backup of the same library contain every canonical file and the comments;
   - validate the backup independently: 0 errors.
5. **Audit chain:** verify passes, and editing one line breaks it at that line.
6. **Personal mode unchanged:**
   - the whole existing suite passes with no shared data present;
   - personal `serve` binds only to loopback, has no auth routes, and refuses `--host` non-loopback.
7. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
