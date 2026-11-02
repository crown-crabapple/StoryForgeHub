# edge-dump: a hand-written legacy dump of awkward cases

Invented data, written by `edge-dump` rows rather than produced from a database. Every value, including the "secrets" in the server-only tables, is fake.

It covers: `---` inside a fenced code block and between table rows; comment-only, heading-only and empty segments; chapters `prologue`, `3.5`, `3` and
`4` (empty); a duplicate `sort_order` and number; an archived chapter; CRLF text; a stale scenes cache; an act that goes backwards; entries with a slug
collision (a location and a faction named `harbour`, then a ledger item), an odd slug and an unknown status; unresolved links, relations, cast and state
changes; a ledger item that points at a chapter that does not exist; a non-UTF-8 value stored as `{"$b64": ...}`; an unknown table (`zz_future_feature`);
server-only tables with fake rows; and every M00-J01 content type at least once. Derived caches (`mentions`, `prose_analysis`, `claim_sources`,
`exercises`, `threads`, `sync_state`) each have one row.

`expected-plan-summary.json` is produced by `node packages/legacy-import/scripts/expected-summary.mjs packages/legacy-import/fixtures/edge-dump`.
