# StoryForge API v1

A small, versioned HTTP API for programs you run yourself: a plugin that reads a book, a script that proposes edits, a receiver that listens for webhooks. It is
served by the same StoryForge process as the app, under `/api/v1`.

The principle: **StoryForge never runs plugin code, and no token can write a canonical file.** A plugin reads what you let it read, and it can *propose* a change.
A proposal is a suggestion; nothing in your book changes until you accept it in the normal review (and accepting writes receipts, as for any suggestion).

The other `/api/*` routes are the app's own and are not part of this API. A token cannot reach them.

## Access tokens

You grant access in **Settings, then Plugins**: choose a plugin (or name one), tick the permissions and books, confirm. StoryForge shows the token once. Only its
SHA-256 is stored (personal mode: `plugin-tokens.json` in your user config folder; shared mode: in the shared-data folder, and only the owner can grant). You can
revoke a token at any time; a revoked token stops working at once.

Send it on every request:

```http
Authorization: Bearer <token>
```

Permissions (a token has one or more):

| Permission | Gives |
|---|---|
| `read` | The read routes below, for the granted books only. |
| `propose` | `POST /api/v1/books/:book/proposals`. |
| `events` | Its own webhook subscriptions (`/api/v1/webhooks`). |

Rules:

- A request with an `Authorization` header is a plugin request. It is decided only by its token: **cookies are never read**, a session cookie adds nothing to a
  plugin call, and a token placed in a cookie is never accepted. `/api/v1` without a bearer token is `401`.
- Personal mode answers loopback clients only. Shared mode checks the `Host` like every request. The browser write header and the `Origin` check do not apply to a
  bearer request, because it carries no ambient authority.
- A token reaches `/api/v1` only. Every other route, every write to a book, admin, AI, export, backup and receipts answer `403 PLUGIN_SCOPE`.
- Shared mode audits every plugin call (`plugin.<route>`, token id, status). A plugin token is not a member and has no role.
- Turning the **Integrations** module off (Settings, Modules, or `modules: { integrations: false }` in `library.md` / `book.md`) stops all API v1 access and webhook
  delivery: every call is `403 MODULE_OFF`.

Books are named by slug in the path (the book's id works too). A book outside the grant is `403 PLUGIN_SCOPE`, whether or not it exists.

## Errors

Every error is JSON: `{ "error": "<kind>", "code": "<CODE>", "message": "<words>" }`.

| Status | Meaning |
|---|---|
| `400` | The request is malformed (`BAD_ARGS`). |
| `401` | No valid token: missing, malformed, unknown or revoked (`TOKEN`). |
| `403` | `PLUGIN_SCOPE` (not this route, permission or book), or `MODULE_OFF`. |
| `404` | No such scene, entry or webhook. |
| `409` | The proposal changes nothing (`NO_CHANGE`) or the file moved on. |
| `413` / `415` | The body is too large (5 MB) / is not `application/json`. |
| `503` | The token file cannot be read (it is never replaced; fix or move it). |

## Read routes (permission `read`)

All answers are JSON. Line breaks in text are `\n`. A `sha256` is the hash of the file's bytes.

| Route | Answer |
|---|---|
| `GET /api/v1` | `{ api: 1, server: "<version>" }` |
| `GET /api/v1/books` | `{ books: [{ id, slug, title, status, series, series_number, language, scenes, words }] }`, granted books only |
| `GET /api/v1/books/:b` | The book with `acts: [{ act, label, chapters: [{ chapter, label, title, scenes: [{ id, title, order, act, chapter, sequence, status, pov, words, path }] }] }]` |
| `GET /api/v1/books/:b/scenes/:id` | One scene: the scene fields above plus `sha256`, `front_matter` (the parsed YAML) and `body` |
| `GET /api/v1/books/:b/entries` | `{ entries: [{ id, slug, type, name, status, role, aliases, archived, path }] }` |
| `GET /api/v1/books/:b/entries/:id` | `{ id, slug, type, name, status, path, sha256, fields, body }` |
| `GET /api/v1/books/:b/threads` | `{ threads: [{ id, slug, title, kind, status, setup, develop, payoff, characters, path }] }` |
| `GET /api/v1/books/:b/events` | `{ events: [{ id, slug, title, order, when, date, scenes: [id], characters, locations, path }] }` |
| `GET /api/v1/books/:b/search?q=&limit=` | `{ query, hits: [{ id, kind, title, path, snippet }] }` (`q` 1 to 200 characters, `limit` 1 to 100, default 20) |
| `GET /api/v1/books/:b/graph` | `{ nodes: [{ id, kind, type, name }], edges: [{ from, to, kind, rel }] }` |
| `GET /api/v1/books/:b/diagnostics` | `{ diagnostics: [{ code, severity, file, location, message }] }` |

## Proposals (permission `propose`)

```http
POST /api/v1/books/:b/proposals
Content-Type: application/json

{ "target": "scene_01…", "text": "<the whole new body>", "rationale": "why" }
```

`target` is the id of a scene, entry, thread or event. Give exactly one of:

- `text`: the whole new body of the target (its front matter is kept as it is);
- `hunks`: `[{ "from": 120, "to": 125, "replacement": "boat" }, …]`, ranges of the body as `GET` returned it (counted in characters, a line break is one). Ranges must not overlap.

`rationale` is optional text (up to 20 000 characters). `base_sha256` is optional: give the `sha256` the target had when you read it, and the proposal is refused (`409 SCENE_CHANGED`) if the file has changed since, so your ranges are never applied to text you have not seen. Answer `201`:

```json
{ "suggestion": { "id": "note_01…", "path": "suggestions/2026/…md", "target": "scene_01…", "status": "pending",
                  "source": "plugin", "plugin": "word-frequency", "by": { "name": "Word frequency" },
                  "created": "2026-11-02T14:03:22Z", "rationale": "why",
                  "hunks": [{ "id": "h1", "line": 17, "lines": 1, "status": "pending" }] } }
```

The suggestion is an ordinary one (`source: plugin`, FORMAT §9.3). The author sees it in the review rail, accepts or declines each hunk, and an accepted hunk writes a
receipt that names the plugin. The target file is not touched by the proposal. `by.name` is the plugin's name from its manifest (else its slug). A proposal that equals
the current text is `409 NO_CHANGE`. The `suggestions` module must be on for the book.

## Webhooks

Webhooks send events *out*. The author creates them in **Settings, then Webhooks**; a plugin with the `events` permission can create its own (for its own URL only).

### Subscriptions made by a plugin (permission `events`)

| Route | |
|---|---|
| `GET /api/v1/webhooks` | `{ webhooks: [...] }`: this plugin's own subscriptions (never a secret) |
| `POST /api/v1/webhooks` | `{ url, events: [...], books?: [slug, …] }` gives `201 { webhook, secret }`. The secret is shown once. `books` defaults to the token's books and can never be wider. |
| `DELETE /api/v1/webhooks/:id` | Revoke one of its own |

A plugin cannot set `include_content` or `allow_local`; asking for either is `400`. Only the author does that, in Settings. A plugin also cannot subscribe an address on this computer (`localhost`, `127.0.0.0/8`, `::1`): `400 LOCAL_NOT_ALLOWED`. Plugins send only to public `https://` addresses.

### Events

`scene.saved`, `scene.created`, `scene.moved`, `entry.changed`, `suggestion.created`, `suggestion.decided`, `export.done`, `backup.done`.

### Delivery

A `POST` with `Content-Type: application/json`, this body and these headers:

```json
{ "event": "scene.saved", "at": "2026-11-02T14:03:22.000Z", "book_id": "book_01…", "target_id": "scene_01…",
  "path": "manuscript/act-01/ch-001/0010-arrival.md", "sha256": "<hash of the file as saved>", "by": { "name": "Ilse" } }
```

- `by` is present when a signed-in person (shared mode) or a plugin did it. `target_id` is `null` for an export or a backup, whose `path` is the file name and `sha256` its hash.
- **There is no text** unless the author ticked "Include the scene text" for that webhook; then scene events also carry `content`, the scene body. The warning in Settings says so in plain words.
- `x-storyforge-signature: sha256=<hex>` is the HMAC-SHA-256 of the **exact request body bytes**, keyed with the webhook's secret. Verify it over the raw bytes, in constant time, before you parse anything. `x-storyforge-event` and `x-storyforge-delivery` (a unique id) are also sent.
- The secret is generated by StoryForge and shown once at creation. It is kept in your user config folder (shared mode: the shared-data folder), never in a library, a backup, a log or an answer.
- Timeout 5 seconds. A failure that could pass (a timeout, a network error, `5xx`, `408`, `429`) is retried 3 times with growing waits (1, 4 and 16 seconds). Other answers (`4xx`) are not retried. After 20 deliveries in a row that failed, the webhook is disabled; create it again to resume.
- Redirects are never followed (a `3xx` is a failure).
- Address rules: `http://` only for this computer (`localhost`, `127.0.0.0/8`, `::1`); `https://` for everything else. An address on a private network (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, unique-local IPv6, or a host name that resolves to one) is refused unless the author ticked "allow local network". No user name or password in the address.
- With no webhook, StoryForge makes no outbound connection at all.

## Compatibility policy

- **Within API major 1, fields are only added.** Existing fields keep their names, types and meaning. Write your plugin to ignore fields it does not know.
- Removing or renaming a field, or changing what one means, is a new major version (`/api/v2`). v1 keeps being served for at least one minor StoryForge release after v2 ships.
- New routes, new optional request fields, new event names and new permissions can appear in v1. A plugin must ignore an event it does not know.
- `GET /api/v1` tells you the API major (`api`) and the server version. A plugin manifest says which major it targets (`api: 1`); a manifest for a newer major shows "needs a newer StoryForge" (`W315`) and cannot be granted.
- Error `code` values are stable; the `message` words are not.
