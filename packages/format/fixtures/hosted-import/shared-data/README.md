# shared-data

The shared-mode store for the `hosted-import` fixture: the files `@storyforge/shared` and `@storyforge/integrations` keep outside a library (`users.json`, `members.json`, `sessions.json`, `invites.json`, `shares.json`, `setup.json`, `settings.json`, `plugin-tokens.json`, `oauth.json`, `webhooks.json`, `audit.jsonl`, `audit-head.json`). It is not part of the library and `validate()` never reads it.

Every token is a fake sha256 hash derived from a fixed label, every password record is fake scrypt-shaped data, and every time is a fixed instant. There are no real secrets. `audit.jsonl` is a valid hash chain: each line's `prev` is the sha256 of the previous line's exact text.
