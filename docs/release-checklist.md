# Release checklist

For the person cutting a release. Work through it in order on a clean checkout of the commit you mean to release, and keep the filled-in list with the release.

Throughout, `<v>` is the new version, for example `0.1.0`.

## 1. Version and changelog

- [ ] Set the version in every package, in step: `node scripts/version.mjs <v>`. It moves each `package.json`, the exact `@storyforge/*` pins and `package-lock.json`.
- [ ] `CHANGELOG.md`: move the Unreleased entries under a new `## [<v>]` heading, by feature family; start a fresh Unreleased section.
- [ ] `docs/release-notes/<v>.md`: guarantees (word for word, as in the previous notes), known limitations collected from the job and gate results since the last release, and upgrade notes.
- [ ] `docs/compatibility.md` still states what is true; any format, API, manifest, index or shared-data change in this release is listed in the notes.
- [ ] Commit: `Release <v>`.

## 2. CI is green on all three systems

- [ ] `npm run ci -- --install` passes on Windows, macOS and Linux (the GitHub Actions matrix does this once there is a remote; until then run it on each system). The summary table lists every step; read the skipped ones and make sure each has a stated reason (the audit skips only when offline).
- [ ] `npm run ci` did not skip `npm audit` on the machine that makes the artifact; if it did, run `npm audit --omit=dev --audit-level=high` on a machine with network access.

## 3. The security checks

- [ ] The secret scan ran in `npm run ci` ("security: secret scan" is `ok`, not "not present yet") and found nothing.
- [ ] The zero-traffic test passes: with no AI provider and no webhook, the app and a typical session make no outbound connection (the zero-traffic tests are part of `npm test`).
- [ ] The licence check lists no new dependency; if one was added, its licence is on the allow-list in `scripts/checks.mjs` and is compatible with AGPL-3.0.
- [ ] `git status` is clean and the working tree holds no local settings, tokens or manuscripts.

## 4. Rehearsals, on copies

- [ ] **Migration rehearsal (M06 tools).** On a copy of a real legacy dump: `import-legacy --dry-run`, then `--into` a new folder twice, `--compare` the two, `--reconcile`, then `rebuild`; see [migration.md](migration.md). The numbers should match the previous rehearsal: 0 unexplained.
- [ ] **Backup and restore drill.** Back up a book, restore it into a new folder, run `repair` (nothing to repair) and `receipts verify`; see [backup-restore.md](backup-restore.md). The restore is byte-identical to the book except for `.storyforge/`.
- [ ] **Docker drill**, on a machine that has Docker: the steps in [self-hosting.md](self-hosting.md); the container becomes healthy, the owner setup link works, a backup restores.
- [ ] **Keyboard and screen reader pass** from [accessibility.md](accessibility.md) if the editor or navigation changed.

## 5. The artifact

- [ ] `npm run release:build` makes `dist/storyforge-<v>.zip` and `dist/storyforge-<v>.zip.sha256`.
- [ ] Build it a second time and compare: the sha256 must be identical.
- [ ] Check the checksum file against the zip (`sha256sum -c storyforge-<v>.zip.sha256` in `dist/`, or `shasum -a 256 -c`).
- [ ] Unzip it into an empty folder, run `npm ci --omit=dev`, `npm start -- --library <a copy of the sample>`, and open the app. (`npm test` runs this as an automated check when the npm cache allows it.)
- [ ] The zip holds no tests, fixtures, `node_modules` or `.git` (a test checks this).

## 6. Tag and publish

- [ ] Tag the release commit: `git tag -a v<v> -m "StoryForge <v>"`, and push the commit and the tag.
- [ ] Create the release page from the tag. Attach `storyforge-<v>.zip` and `storyforge-<v>.zip.sha256`; paste the release notes as the description and state the checksum in the text too.
- [ ] Publishing notes: lead with the six guarantees; list the known limitations plainly; say which systems the release was checked on and which checks were skipped and why; link [install.md](install.md) and the upgrade notes; credit contributors.
- [ ] After publishing, download the zip from the release page, check its sha256 against the one in the notes, and start it once.
- [ ] Add the next Unreleased section to the changelog if it is not there.
