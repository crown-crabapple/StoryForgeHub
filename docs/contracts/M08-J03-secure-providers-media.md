# M08-J03 contract — secure providers and optional media integrations

Binding: DECISIONS 9, 11, 12; M05-J04 AI workshop (profiles, key storage `none | session | config`, preview-then-send, local/cloud locality, zero-traffic test); M07-J04 prompt workflows and `ai` module; M08-J01 deployment (container `/config`, `/shared-data`); M08-J02 webhook secrets.

## 1. Secret storage (coordinator-written core)

**Store:**
- A new module, `packages/ai/src/keystore.mjs`. It holds every secret StoryForge keeps: AI provider keys and webhook signing secrets.
- `keyStorage` gains `secure`, which becomes the **default** for a new key when a secure backend is available. The existing `config` (plain text in the user config file) stays, with a warning; `session` and `none` are unchanged.

**Backends**, picked in this order at start; the active one is reported in Settings:

| Backend | When | How |
|---|---|---|
| `dpapi` | Windows | The secret is encrypted with Windows DPAPI (CurrentUser) by a spawned `powershell.exe -NoProfile -NonInteractive` that reads the plaintext from **stdin**. The ciphertext is base64 in `<config>/secrets.json`, so only this Windows user on this machine can decrypt it. |
| `macos-keychain` | macOS with `security` | `security -i` with the commands given on **stdin**, never in argv, under service `storyforge`, account = secret id |
| `secret-service` | Linux with `secret-tool` and a session bus | `secret-tool store` (secret on stdin) / `lookup` |
| `file-key` | everything else (servers, containers) | AES-256-GCM. The 32-byte key is in `STORYFORGE_SECRETS_KEY` (base64) or `<shared-data or config>/secrets.key` (mode 0600, created on first use). The ciphertext is in `secrets.json`. The docs say to back up the key separately or keys will need re-entering. |

**Rules:**
- No secret ever appears in argv, environment of child processes (except `STORYFORGE_SECRETS_KEY` given by the operator), logs, error messages, receipts, AI records, suggestions, exports, backups, the library, or API responses.
- Responses only say `{ hasKey: true, storage }`.
- Process spawning is allowed by the ESLint process rule in `keystore.mjs` only.
- Decrypted values are cached in memory for the life of the process.
- **Migration:** profiles with `keyStorage: 'config'` keep working. Settings offers "Move key to secure storage", which writes the secure copy, deletes the plain one, and audits it in shared mode.

## 2. Providers

**Capability discovery:** "Test connection" also lists models.
- OpenAI-compatible: `GET {base}/models`.
- Ollama: detected by `GET {base}/api/tags` on a localhost base.
- It shows whether streaming and token usage are reported.
- The result is cached per profile, and discovery sends no manuscript data.

**Streaming:**
- Chat and rewrite replies stream (SSE for OpenAI-compatible, NDJSON for Ollama) into the existing workshop panel. Cancel stops the request.
- A rewrite still becomes a suggestion only when complete, and is never applied automatically.

**Token accounting:**
- The provider's reported usage is used, or an estimate (chars / 4) clearly marked "estimated" when none is reported.
- It is shown per request and summed per book per day in `activity/ai-usage.md`: a `storyforge.doc/v1` table with columns date, profile, locality, requests, prompt tokens, completion tokens, estimated. The file is optional and off unless AI records or usage tracking is on for the book.
- It is never sent anywhere.

**Indicators:** a local/cloud badge on every send button and preview (exists, M05-J04; keep). The context preview (exists) is shown before every send, workflows included.

## 3. Cover generation (optional, off by default)

- An image profile kind, `openai-compatible-images` (`POST {base}/images/generations`), uses the same key storage and locality.
- **Flow:**
  - book → Cover → **Generate a draft**;
  - a prompt editor, prefilled from title, genre and logline;
  - a **consent dialog** that names exactly what leaves the computer (the prompt text, nothing else), the provider and host, and local/cloud;
  - Send.
- **Results:**
  - saved as **draft assets** `assets/drafts/cover-<YYYYMMDD-HHMMSS>-<n>.png` through the store;
  - each has a sidecar `.md` (`storyforge.asset-note/v1`: prompt, provider, model, locality, created, sha256);
  - a receipt is written (`ai.generation`, target the asset).
- A draft becomes the cover only when the author picks **Use as cover**, a single-line `book.md` edit. Drafts can be deleted to trash.
- No image provider configured means no button, and zero requests.
- The `ai` module off hides it.

## 4. Acceptance

1. **Secret scans prove keys do not enter project files or backups:**
   - Set a recognisable fake key (`sk-test-<random>`) for an AI profile and a webhook, with every storage option the platform supports, plus `file-key`.
   - Do a full session: preview, send to a mock provider, rewrite, accept, export in every format, backup with provenance, AI records on, cover generation.
   - Grep every file under the library, every export and backup (unzipped), server stdout/stderr, receipts, AI records and the shared data: the key appears **nowhere**.
   - It appears in `secrets.json` only as ciphertext for `dpapi` and `file-key`.
   - API responses never include it.
2. **A local mock provider records token use and consent:**
   - The mock reports usage and the totals show it.
   - A mock without usage gives "estimated" totals.
   - Every outbound request is preceded by an explicit send for a previewed context (net recorder).
   - Cover generation sends only after consent, and exactly the shown prompt.
3. **No configured provider means zero requests:** the existing zero-traffic test, extended to discovery, image generation and webhooks.
4. **Backends:**
   - `dpapi` round trip on Windows (this machine);
   - `file-key` round trip on every platform;
   - the others are skipped with a message when their tool is missing;
   - a wrong key or a wrong user gives a clear "cannot unlock stored keys" error and never a crash or a silent empty key.
5. **Streaming:** cancel mid-stream, and partial output is never applied. Discovery lists the mock's models.
6. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
