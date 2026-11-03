# Compatibility policy

What stays the same when StoryForge is upgraded, and what is allowed to change. The aim: your books, your tools and your server keep working across upgrades, and anything that must change is announced and has a way through.

## The app: semantic versioning

StoryForge versions are `MAJOR.MINOR.PATCH`, set in step in every package by `node scripts/version.mjs <x.y.z>` and recorded in the [changelog](../CHANGELOG.md).

- **Patch** (0.1.0 to 0.1.1): fixes only. No change to the format, the API or any file version.
- **Minor** (0.1 to 0.2): new features, additive changes only. Everything that worked keeps working. An index schema change (below) may make the first start rebuild.
- **Major** (1.x to 2.0): the only place a breaking change may appear: a format v2, an API v2, a changed manifest. The release notes say what to do, and old data is never rewritten without an explicit command.
- Before 1.0, minor versions may carry the changes a major would carry later; the release notes of each say so in an "Upgrade notes" section. The promises about your Markdown files below hold from 0.1.0 onward.

## The book format (v1)

The format is specified in the project's FORMAT document (section 10, "Compatibility and upgrades") and described for users in [format.md](format.md).

- **Additive within v1.** New optional fields and new optional files may be added without changing the version. Existing fields keep their names, types and meaning, and the ordering rule does not change. Renaming, removing or re-typing a field needs v2.
- **A reader ignores what it does not know.** Write tools to skip unknown fields.
- **A newer major than the reader knows** is reported (`E006`), shown read-only and never written. It is left out of ordering and link resolution.
- **An older major** is read through a documented upgrade function. Files are rewritten only when the author runs an explicit upgrade, which copies the originals to the book's trash first, changes front matter only, writes a receipt and is safe to run twice.
- A format addition made in a release is marked in the format document as "additive within v1" with the job that added it.

## API v1

The HTTP API for plugins and tools is described in [api.md](api.md).

- **Within API major 1, fields are only added.** Names, types and meanings of existing fields stay. Clients must ignore fields they do not know.
- Removing or renaming a field, or changing what one means, is a new major (`/api/v2`). v1 keeps being served for at least one minor StoryForge release after v2 ships.
- Error `code` values are stable; the `message` words are not.
- `GET /api/v1` reports the API major and the server version.
- There is no write permission in API v1 and none will be added within v1: a plugin proposes, and the author accepts.
- Webhook events carry ids and hashes (never text unless the author opts in); new event types and fields may be added, so receivers must ignore ones they do not know and verify the signature.

## The plugin manifest

A manifest (`_plugins/<name>/plugin.md`, schema `storyforge.plugin/v1`) names the API major it targets (`api: 1`).

- A manifest for the API major this StoryForge serves, or an older one it still serves, works.
- A manifest for a newer major is shown as `W315` ("needs a newer StoryForge") and cannot be granted.
- New optional manifest fields are additive within `storyforge.plugin/v1`. Removing or re-typing one needs `storyforge.plugin/v2`.
- Granting a token is always the author's act; an upgrade never grants or widens a token.

## The index schema

`.storyforge/index.sqlite` is a disposable projection of the Markdown files. It carries a schema version.

- When the schema changes, the old index is not migrated: it is reported stale and rebuilt from the Markdown files, on start or with `rebuild`.
- Deleting `.storyforge/` is always safe; nothing that is only in the index is ever the author's text.
- Downgrading to an older StoryForge may mean one rebuild for the same reason.

## Shared-data files

Shared mode keeps accounts, members, sessions, invites, shares, plugin tokens, settings and the audit log in its own folder (never inside a library). Each JSON file carries `"version": 1`.

- A file with a version or shape the running StoryForge does not understand is refused with a clear error and is never overwritten or guessed at.
- A new version of a shared-data file is introduced only with a documented, explicit upgrade step; the release notes name it.
- The audit log is an append-only hash chain. Its line format and its head anchor (`audit-head.json`) are stable across minors; `audit verify` reads logs from older versions.

## Other files

- **Per-user settings** (recent libraries, AI profiles, preferences): new settings are added with defaults.
- **Backups** (`.zip`) made by one version are restorable by every later version, and restore validates the result.
- **Exports** (Markdown, Word, EPUB, PDF) are deterministic for the same input and version; a new version may improve layout and says so in the changelog.
- **The release zip** is named `storyforge-<version>.zip` with a `.sha256` file beside it.
