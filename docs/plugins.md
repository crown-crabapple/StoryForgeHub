# Writing a plugin

A StoryForge plugin is a separate program you start yourself, in any language. It talks to StoryForge over the [HTTP API](api.md) with an access token you granted.
StoryForge never loads or runs it, so a plugin that crashes or misbehaves can only lose its own token.

Two complete samples are in `examples/`. Neither has a dependency; both need Node 22 or newer.

## 1. Describe it (optional)

Put a manifest in your library at `_plugins/<name>/plugin.md`. It describes what the plugin will ask for; it grants nothing.

```yaml
---
schema: storyforge.plugin/v1
id: note_01S8000000000000000000WF01   # note_ plus a 26-character ULID
plugin: word-frequency                # a slug, unique in the library
name: Word frequency
version: 1.0.0
api: 1                                # the API major it targets
permissions: [read]                   # read | propose | events
books: all                            # all | [book-slug, …]
---
What it does, in plain words.
```

Settings, then Plugins, lists the manifests it finds and shows problems: a bad field is `E102`, an unknown permission is `E102` at `permissions[i]`, and an `api` newer than
this StoryForge serves is `W315` ("needs a newer StoryForge"). `_plugins/` is never read as a book.

## 2. Get a token

Settings, then Plugins, then **Grant access** next to the manifest (or **Grant access to another plugin** if it has none). You see the permissions in words and the books, and you can narrow
both. After you confirm, the token is shown **once**: copy it. Give it to the plugin through an environment variable, not a file in your library. Revoke it any time from the same page.

## 3. Read a book: `examples/plugin-word-frequency/`

```sh
STORYFORGE_TOKEN=<token> node examples/plugin-word-frequency/plugin.mjs --book salt-orchard
```

It lists the book (`GET /api/v1/books`), reads its outline, reads every scene, and prints the top words of each chapter. The whole thing is one `fetch` helper:

```js
const res = await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
```

Ask only for what you need: a `read` token is enough to read; a token with only `read` that tries to propose gets `403 PLUGIN_SCOPE`.

## 4. Propose a change

With the `propose` permission:

```js
await fetch(`${base}/api/v1/books/salt-orchard/proposals`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ target: sceneId, text: newBody, rationale: 'Her eyes are grey elsewhere.' }),
});
```

This makes a suggestion. **It does not change the scene.** The author reviews it in the right rail of the scene, accepts or declines each hunk, and an accepted hunk is recorded
in a receipt that names your plugin. Send `text` (the whole new body) or `hunks` (`from`/`to`/`replacement` ranges of the body you read). Ranges count against the file as it is when the proposal arrives, so
send `base_sha256` (the `sha256` you read with the scene): if the author changed the scene in between, the proposal is refused with `409 SCENE_CHANGED` instead of landing on the wrong text.

## 5. Listen for events: `examples/webhook-receiver/`

Create a webhook in Settings, then Webhooks (or, with the `events` permission, `POST /api/v1/webhooks`). Copy the secret it shows once, then:

```sh
STORYFORGE_WEBHOOK_SECRET=<secret> node examples/webhook-receiver/receiver.mjs --port 8787 --out events.jsonl
```

and use `http://127.0.0.1:8787/` as the address. The receiver checks `x-storyforge-signature` (the HMAC-SHA-256 of the raw body, keyed with the secret) in constant time, answers `401` to anything that does not
match, and appends each good event as one line. The event is `{ event, at, book_id, target_id, path, sha256 }`: ids and a hash, never your text. If you need the text, read it
with the API (`GET …/scenes/:id`) when the event arrives, so the author decides what a plugin may read; the author can also turn on "Include the scene text" for a webhook they trust.

To connect Claude Code or Claude Desktop with a token, see [mcp.md](mcp.md).

## What a plugin cannot do

- Write any file of the book: scenes, entries, planning files, receipts. Proposals are the only way to suggest one, and only the author applies it.
- Reach any route outside `/api/v1`: no export, backup, restore, AI, settings, members or receipts.
- Read a book it was not granted, or use a token that was revoked.
- Turn on "Include the scene text" for a webhook, or send one to the local network. Only the author does.

If you are unsure what your token can do, `GET /api/v1/books` shows the books it can see, and every refusal says which permission or book was missing.
