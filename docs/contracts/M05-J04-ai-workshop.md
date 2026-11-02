# M05-J04 contract — optional, provider-agnostic AI workshop

Binding: DECISIONS 1, 6, 9, 11, 12; CLAUDE-BOOK-INTEGRATION (modes, no automatic application); contracts M01-J01 (user config dir), M03-J02 (editor), M03-J03 (exact Undo), M05-J01 (continuity findings may be context).

**Absent by default.** With no provider profile, StoryForge never opens an outbound connection, shows no AI controls beyond one "Set up AI (optional)" entry in Settings, and every other feature works.

## 1. One network module

- New package `@storyforge/ai`. It is the **only** place in `packages/*` and `apps/server` that may perform outbound network I/O (`fetch`, `http(s).request`, `net`, `tls`, `dgram`, `WebSocket`).
- ESLint: `no-restricted-globals`/`no-restricted-imports` for `fetch`, `node:http`'s `request`/`get`, `node:https`, `node:net`, `node:tls`, `node:dgram`, `undici` everywhere in `packages/**` and `apps/server/**` except `packages/ai/src/transport.mjs`; `apps/server/src/server.mjs` keeps `http.createServer` only (allow via a narrow override). A lint test asserts a planted `fetch` in another package fails lint.
- `transport.mjs` exports one function `postJson(url, body, { headers, timeoutMs, signal })`; refuses non-`http:`/`https:` URLs, `http:` to non-loopback hosts (cloud must be https), redirects (`redirect: 'error'`), and responses > 8 MB.

## 2. Provider profiles and credentials

- Stored in the **user config dir** (`readUserConfig`/`writeUserConfig`), key `ai.profiles`, never in a book folder and never in a backup:
  `{ id, name, kind: 'openai-compatible', baseUrl, model, temperature?, maxTokens?, contextBudget (tokens, default 8000), keyStorage: 'none'|'session'|'config', createdAt }`.
- **Locality** is derived, not chosen: `local` when the base URL host is `localhost`, `127.0.0.1`, `[::1]`; otherwise `cloud`. Shown everywhere a request can be sent.
- **Credentials (opt-in):** `keyStorage: 'none'` (no key; typical for local servers), `'session'` (kept in server memory until restart — default when a key is entered), `'config'` (saved in the user config file in plain text; the UI says exactly that and where the file is). The key is **never** returned to the browser (API returns `hasKey: true|false`), never logged, never written into books, receipts, records or exports, and is sent only as `Authorization: Bearer` to that profile's base URL.
- One **active** profile per book is stored in user config `ai.bookProfiles[bookId]` (not in the book). No active profile → AI is off for that book.
- Routes (write-guarded): `GET /api/ai/profiles` (no keys), `POST /api/ai/profiles`, `PUT /api/ai/profiles/:id`, `DELETE /api/ai/profiles/:id`, `PUT /api/books/:b/ai/profile` `{ profileId|null }`, `POST /api/ai/profiles/:id/test` (sends one tiny fixed prompt "Reply with OK." — the only request that carries no book text; requires explicit click).

## 3. Context packages — inspectable before sending

- `POST /api/books/:b/ai/context` `{ task: 'chat'|'rewrite', files: [book-relative paths], selection?: { sceneId, from, to }, instruction }` → builds and returns the **exact** request body that would be sent, without sending:
  `{ contextId, messages: [{ role, content }], files: [{ path, sha256, bytes, tokens, included: 'full'|'truncated'|'omitted' }], tokens: { estimate, budget }, provider: { name, model, baseUrl, locality }, contextSha256 }`.
- Token estimate = `ceil(chars / 4)`; files added in the given order until the budget; the rest `omitted` (never silently cut mid-file except the last, marked `truncated`). Front matter kept; `.storyforge/`, `provenance/`, files outside the book → 400.
- `contextSha256` = sha256 of the canonical JSON of `messages` + model + settings. The server keeps the package in memory for 15 minutes keyed by `contextId`.
- **Send** only by `contextId`: `POST /api/books/:b/ai/send { contextId, confirmCloud? }` sends exactly the stored messages. For `cloud` locality, `confirmCloud: true` is required on every send (else 409 `CLOUD_CONFIRM_REQUIRED`); the UI asks with the host name and token count each time (a "don't ask again for this book this session" checkbox is allowed, held in browser memory only).

## 4. Flows

- **Chat:** a panel (right side, toggled from the editor toolbar and the book header "AI workshop") with: context picker (current scene preselected; add scenes/entries/notes by search), instruction box, **Preview context** (shows messages, file list with token counts, locality badge), **Send**. Replies shown as Markdown; nothing is written to the book.
- **Rewrite:** select text in the editor → "Rewrite with AI…" → instruction → preview → send → result shown as a **diff** (unified, word-level highlight) against the selection; buttons **Apply**, **Discard**. Apply writes through the store with `baseSha256` of the scene as it was when the context was built **and** checks that the selected range still contains exactly the original text → else 409 `SCENE_CHANGED` (nothing written). Apply changes only the selected range; the rest of the file is byte-identical. Undo restores the prior bytes exactly.
- Model output is untrusted text: rendered with the same safe Markdown renderer as notes (no raw HTML), never executed, never used as a file path.
- **Provenance hook:** every send, apply and discard calls `recordProvenance(event)` from a small module in `@storyforge/core` that is a no-op in this job (M05-J07 implements it). Event shape: `{ kind: 'ai.proposal'|'ai.apply'|'ai.discard'|'ai.chat', bookId, sceneId?, contextSha256, provider: { name, model, locality }, settings, before?, after?, range? }`.

## 5. Optional AI records (project-local)

- Book-level toggle stored in user config `ai.recordBooks[bookId]` (default **off**); not in `book.md`.
- When on, each chat/rewrite saves `ai/<YYYY>/<YYYYMMDD-HHMMSS>-<task>.md` in the book (schema `storyforge.ai-record/v1`, id prefix `note`): front matter `{ task, provider, model, locality, contextSha256, files: [paths + sha256], applied: true|false }`, body = instruction and reply (and the selected text for rewrites). Written through the store. The full context text is **not** saved unless the user ticks "Include the full context" for that record.
- Add `ai/` to FORMAT-v1 §2 and the kind to §11.1 (required: `task`, `provider`, `model`); dated mark M05-J04. Validator accepts it with no diagnostics.

## 6. Acceptance

1. **Zero traffic with no provider:** start the server on a copy of salt-orchard with an empty user config dir; with `globalThis.fetch`, `http.request`, `https.request`, `net.connect`, `tls.connect` and `dgram.createSocket` wrapped to record calls, exercise every read route and every write route family (scenes, codex, timeline, notes, export, backup, continuity) → **zero** outbound calls. AI routes return 409 `AI_NOT_CONFIGURED`. Lint rule test (§1).
2. **Local test provider:** an OpenAI-compatible mock server in the test (`POST /v1/chat/completions` on 127.0.0.1, records request bodies) → the body received is byte-for-byte the `messages` from the preview (same `contextSha256`); omitted files absent; locality `local`.
3. **Rewrite apply:** accepted rewrite changes only the selected range (rest byte-identical), journaled atomic write, Undo byte-identical; `SCENE_CHANGED` when the scene or the range changed after preview; Discard writes nothing.
4. **Credentials:** key never in any API response, log line, book file or backup; `session` key gone after restart; `config` key present in the config file only; cloud send without `confirmCloud` → 409, with → sent with `Authorization` header; http non-loopback base URL refused at profile save.
5. **Records:** off by default (no `ai/` folder created); on → record file valid, no key, context text only when chosen.
6. **Render tests:** settings profiles (add/edit/delete, locality badge, key storage choices with plain text), chat panel, context preview, diff view with Apply/Discard, cloud confirmation dialog.
7. **Manual (coordinator):** with the mock provider, preview → send → rewrite → apply → undo, screenshots.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
