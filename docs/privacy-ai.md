# Privacy and the optional AI workshop

## Without AI

StoryForge sends nothing anywhere. The app listens on `127.0.0.1` only, has no account, no tracking and no update check, and works fully with no AI provider set up. With
none set up, the only AI control you see is one entry, **Set up AI (optional)**, in Settings.

## With AI

AI is off until you add a provider in **Settings** and turn it on for a book. StoryForge works with any provider that speaks the OpenAI-compatible chat interface: a model
running on your computer, or a cloud service you choose.

### Local or cloud

StoryForge decides this from the address you give the provider, and shows it wherever something can be sent:

- **Local:** the host is `localhost`, `127.0.0.1` or `[::1]`. The text goes to a program on your own computer.
- **Cloud:** any other host. The text leaves your computer and goes to that service. A cloud address must be `https`.

For a cloud provider StoryForge asks you to confirm every send, naming the host and the size of what will be sent.

### What gets sent

Nothing is sent when you open a book, write, or look at a preview. Text is sent only when you press **Send**, and only the text shown in the preview:

1. Pick what the model may see: the current scene, and any scenes, entries or notes you add.
2. Press **Preview context**. StoryForge shows the exact messages, each file with its size, and which file was cut or left out to fit the budget.
3. Press **Send**. What goes out is exactly what the preview showed.

`.storyforge/`, `provenance/` and files outside the book can never be included.

The one request that carries no book text is the connection test in Settings, which sends a fixed short prompt and only when you click it.

### What changes your book

A reply from the model never changes your book on its own. A chat reply is only shown. A rewrite is shown as a before/after comparison, and nothing is written until you press
**Apply**. If the scene changed since the preview, Apply is refused and nothing is written. Undo puts the earlier text back exactly.

### Your key

A provider may need a key. You choose where it lives:

| Choice | What happens |
| --- | --- |
| Keep the key in secure storage (recommended, the default for a new key) | Encrypted by your operating system: Windows protected storage (DPAPI) for your Windows user, the macOS keychain, or the Linux Secret Service. Where none of those exists (a server, a container) the key is encrypted in a file with a key of its own ([self-hosting.md](self-hosting.md), "Secrets"). Settings shows which one is in use. Webhook signing secrets are kept the same way. |
| No key | Nothing stored. Typical for a model on your own computer. |
| Keep the key for this session only | Held in memory until StoryForge stops. |
| Save the key in the settings file, as plain text | Written to the settings file in your settings folder ([install.md](install.md), "Where your data lives"). Anyone who can read that file can read the key. Settings offers **Move key to secure storage**, which writes the secure copy and then deletes the plain one. |

If StoryForge cannot unlock a stored key (it was saved by another Windows user or on another computer, or the key file of an encrypted store is missing), Settings says "cannot unlock stored keys", nothing is sent, and you enter the key again. A key is never replaced by an empty one.

The key is never shown back in the app and is sent only to that provider's address. It is never written into a book, a backup, an export or a receipt. Provider settings are
kept in the settings folder, not in the book.

### Models, streaming and tokens

**Test connection** in Settings lists the models the provider offers (an OpenAI-compatible `/models` list, and Ollama's `/api/tags` for a provider on this computer) and shows whether it streams and reports token use. It sends only that one fixed test message, never any of your text. Replies stream into the panel as they arrive and can be cancelled; a reply is shown as it comes but is never applied, suggested or saved until it is complete, and a cancelled or interrupted one is thrown away.

Each reply shows its tokens: the provider's own count, or, when it reports none, an estimate (characters divided by four) marked **estimated**. If you turn on **Keep a daily token table for this book** (or AI records), the totals per day, provider and locality are kept in the book's `activity/ai-usage.md`: counts only, never sent anywhere.

### Cover drafts (optional)

An *image* provider (an OpenAI-compatible images endpoint) can be added the same way and chosen for a book. Then **Cover drafts** appears on the book page. **Generate a draft** opens a prompt editor (prefilled from the title, genre and logline); before anything is sent a dialog shows exactly what leaves your computer, which is **only that prompt text**, to which provider and host, and whether that is on your computer or in the cloud. Results are saved as drafts in `assets/drafts/` with a small note (prompt, provider, model, hash) and a receipt. A draft becomes the cover only when you choose **Use as cover**, which changes one line of `book.md`; drafts can be deleted to the trash. With no image provider there is no button, and nothing is ever requested.

### AI records

Optional, and off for every book until you tick **Save each chat and rewrite as a file in this book (ai/ folder)** in Settings. When on, each chat or rewrite is saved in the
book's `ai/` folder as a Markdown file: the task, provider, model, whether it was local or cloud, the files given, your instruction and the reply. The full context text is
saved only if you tick **Include the full context in the saved record** for that one record. These files are part of the book and go into backups.

## Receipts

A book keeps receipts: small files in `provenance/` that record who changed a scene (you, an AI suggestion you accepted, or a change made outside StoryForge), chained with
hashes so tampering shows. Receipts stay in the book folder and are sent nowhere unless you export them. They are a record of what happened, not a legal finding about who
owns or can copyright any text.

- A normal export holds only the manuscript: no receipts, prompts or provider data.
- A backup leaves receipts out unless you ask for them (**Include receipts (provenance)** in the app, `--provenance` in a terminal).
- `export --include evidence` makes the private evidence package, which holds your text history. Do not share it casually.
- To check the chain: `node apps/server/src/main.mjs receipts verify --library <folder> --book <slug>` (read-only). `--json` prints the result in machine-readable form.

If a check reports a problem, see [troubleshooting.md](troubleshooting.md).
