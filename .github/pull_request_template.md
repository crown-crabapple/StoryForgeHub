## What this changes

<!-- In plain words. Link the job or contract (docs/contracts/...) or the issue. -->

## Checklist

- [ ] `npm run ci` passes locally (or the steps skipped, and why, are listed below)
- [ ] Tests cover the change, and a bug fix has a test that fails without it
- [ ] Only `packages/store` writes project files; outbound network code stays in the two transport files; no telemetry
- [ ] Docs and `CHANGELOG.md` (Unreleased) are updated for anything a user would notice
- [ ] No real manuscript text, secrets, tokens or personal data in code, fixtures, tests or the description
- [ ] Format changes are additive within v1 (see `docs/compatibility.md`)

## Notes for the reviewer

<!-- Known limits, things you chose not to do, anything you are unsure about. -->
