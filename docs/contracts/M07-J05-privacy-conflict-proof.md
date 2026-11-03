# M07-J05 contract — collaboration privacy and conflict proof

Binding: DECISIONS 1, 9, 11, 12; contracts M07-J03 (shared mode) and M07-J04 (modules); M05-J04 AI zero-traffic rules; M05-J03 export/backup.

This job **proves** properties; it does not add features. It is one consolidated suite, `apps/server/test/m07-proof.test.mjs` (plus `*.large.mjs` if a case is slow), driving the real server in both modes on copies of fixtures.

**When a test finds a defect:**
- The test stays and is marked `todo`, naming the defect.
- The defect is reported to the coordinator.
- The worker does NOT edit `packages/shared/src/*`, `apps/server/src/policy.mjs` or `apps/server/src/shared-gate.mjs`. The coordinator fixes those personally.
- Other product fixes are allowed only if small and named in the report.

## 1. Security (shared mode)

1. **Roles:** for every write route in `WRITE_CLASSES` and every GET class, the four roles, a read share, an export share and an anonymous caller each get exactly the result `allowed()` predicts. Every refused call leaves every library file unchanged (snapshot).
2. **Escalation attempts:**
   - an editor PUTs `members/<self>` with role owner;
   - a reviewer sends `source: author` or a forged `by` on a suggestion (the server must set them);
   - a viewer posts a comment;
   - an editor calls any `/api/shared/*` write;
   - a share calls any write, another book, or a private read (receipts, suggestions, comments, raw, notes, revisions).

   All are refused, and no file changes.
3. **Sessions:**
   - login always issues a new token (an old cookie value sent before login is not adopted);
   - a role change applies on the very next request;
   - removing a member kills their live session;
   - a password change kills every other session;
   - the idle and absolute expiries hold;
   - logout clears the cookie;
   - a tampered token (one character changed) is anonymous.
4. **Invites and shares:** expired, revoked and reused invites are refused. A revoked or expired share stops working on the next request, even for a browser that already holds its cookie.
5. **Request forgery:** each of these makes no change:
   - a write with no `x-storyforge` header;
   - `Content-Type: text/plain` (simple-form CSRF shape);
   - a missing, wrong or `null` Origin;
   - a wrong Host (DNS rebinding);
   - `raw?path=../..` and encoded traversal.
6. **Audit integrity:**
   - every refused and accepted state-changing call appears once, in order;
   - `audit verify` passes;
   - editing, deleting or reordering any line, or truncating the tail, is detected;
   - the audit log and shared-data files contain no password, no token and no scene text (search for known values).

## 2. Conflicts and attribution

1. Simultaneous edit, offline reconnect, and a 3-way case (three editors from one base): no text is lost, and every losing buffer becomes a suggestion with the right `by`.
2. Comments and suggestions carry the right `by` for each role. Accepting a reviewer's suggestion produces a receipt naming the accepting editor, with the suggestion linked.
3. **Backup and restore while shared:**
   - back up a book that has comments, suggestions and receipts from several users;
   - restore it into a new folder;
   - `validate()` gives 0 errors;
   - `receipts verify` passes;
   - every `by` survives.

## 3. Privacy

1. **Personal mode:**
   - the server listens only on loopback (check the socket address);
   - there are no `/api/auth` or `/api/shared` routes;
   - nothing anywhere asks for an account;
   - no shared-data folder is created or read (watch the config folder).
2. **AI in shared mode:**
   - with no provider configured, zero outbound traffic (reuse the network-recorder preload from the AI zero-traffic tests);
   - with "Allow AI for members" off, an editor's `ai-context`/`ai-send` are refused and nothing is sent;
   - with it on, nothing is sent before an explicit `ai-send` for a previewed context;
   - with the `ai` module off, nothing is sent even for the owner;
   - a share or reviewer can never reach AI.
3. **Nothing leaves in logs:** server stdout/stderr during a shared session contain no password, token or scene text.

## 4. Same project from both modes (acceptance)

1. Run a shared-mode session with edits, comments and suggestions from several users.
2. Stop it and start personal mode on the same library.
3. Export the book (Markdown and DOCX) and make a Markdown backup from **both** modes:
   - shared mode, as owner;
   - personal mode, via the CLI.
4. The two Markdown exports are byte-identical, the DOCX document parts are identical, and the two backups hold the same files with the same bytes.
5. Each backup restored and validated independently has 0 errors, and an independent `tools/canon-check/resolve.mjs` run on each restore gives identical output.

## 5. Done when

The suite passes (or every failing case is a reported `todo` defect the coordinator has then fixed), and `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
