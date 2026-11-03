# M08-J05 contract — CI, releases and contributor operation

Binding: owner decisions 2026-11-02: licence **AGPL-3.0-only**; there is no git remote yet, so CI files are written for GitHub Actions and the same steps run locally through one script. DECISIONS 1, 7, 9, 12; every M00–M08 contract.

## 1. One command that is the CI — `npm run ci`

`scripts/ci.mjs` runs these steps in order, prints a summary table, and exits non-zero on the first failure:
1. `npm ci` (or a check that the lockfile is in sync);
2. build;
3. lint;
4. typecheck (if configured);
5. the whole `npm test`;
6. `npm run test:large`;
7. **format fixtures** (the validator goldens, part of test, also listed separately in the summary);
8. **atomic write, rebuild, import and export suites** (named groups);
9. **UI smoke:** build the web app, start the server on a copy of the sample, fetch the index HTML and the main routes, and check the `200` responses and the app shell;
10. **security and dependency checks:**
    - `npm audit --omit=dev --audit-level=high`, which needs the network and is skipped with a notice offline;
    - a licence check of every production dependency against an allow-list compatible with AGPL-3.0;
    - the secret scan from M08-J03;
    - the network-boundary lint;
11. **release artifact build** (§3).

`.github/workflows/ci.yml` runs `npm run ci` on Windows, macOS and Linux with Node 24, and caches npm. It is written and linted (YAML parse) but not run, because there is no remote.

## 2. Project files

- `LICENSE`: the full AGPL-3.0 text. Every `package.json` gets `"license": "AGPL-3.0-only"`.
- `README.md`: what StoryForge is, the data-ownership guarantees, install, the docs index, and the licence.
- `CONTRIBUTING.md`:
  - set-up (link to `docs/development.md`) and the job/contract workflow;
  - tests required for a change;
  - the boundaries (single writer, network module, no telemetry);
  - commit style;
  - how to add a fixture.
- `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1, with the contact left as a placeholder for the owner.
- `SECURITY.md`:
  - supported versions;
  - private reporting, with the contact as a placeholder;
  - the shared-mode threat model summary;
  - what is in and out of scope.
- `.github/ISSUE_TEMPLATE/` (bug, feature, data-loss report, which asks for no manuscript content) and `.github/pull_request_template.md`.
- `CHANGELOG.md`, in Keep a Changelog format: `0.1.0` lists M00–M08 by feature family (F01–F20), plus an "Unreleased" section.
- `docs/compatibility.md`, the policy for:
  - the format (v1 additive rules, FORMAT §10);
  - API v1 (M08-J02);
  - the plugin manifest;
  - the index schema (rebuild on change);
  - shared-data file versions;
  - semantic versioning of the app.

## 3. Versioned release artifact

- The version comes from the root `package.json` (`0.1.0`) and is kept in step in every workspace by `scripts/version.mjs <x.y.z>`.
- `npm run release:build` → `dist/storyforge-<version>.zip` plus `.sha256`, containing:
  - the built web app;
  - the server and package sources;
  - `package.json` and `package-lock.json`;
  - the launchers, `deploy/`, `docs/`, `LICENSE`, `README.md` and `CHANGELOG.md`;
  - no tests, fixtures, `node_modules` or `.git`.
- It is deterministic: sorted entries and fixed timestamps, so the same commit gives the same sha256.
- A test unzips it into a temp folder, runs `npm ci --omit=dev`, starts StoryForge on a copy of the sample, and checks it answers. It runs offline using the local npm cache, and is skipped with a notice when the cache cannot satisfy it.

## 4. Release documentation

- `docs/release-checklist.md` covers:
  - version bump;
  - changelog;
  - `npm run ci` green on all three OSes;
  - the secret scan;
  - the zero-traffic test;
  - the migration rehearsal (M06 tools) on a copy;
  - the backup/restore drill;
  - tagging;
  - the artifact checksum;
  - publishing notes.
- `docs/release-notes/0.1.0.md` covers:
  - **guarantees:** no paywalls; no mandatory telemetry (none at all); no account required in personal mode; Markdown is canonical, and the folder is the whole project; AI is off until configured, and nothing is sent without preview and Send; receipts are private;
  - **known limitations**, collected from every RESULT and gate file;
  - **upgrade notes:** from the legacy StoryForgeHub (M06 docs) and between versions (indexes rebuild).

## 5. Acceptance

- A clean contributor checkout (a fresh `git clone` into a temp folder) runs `npm run ci` to completion with every step green, or skipped with a stated reason (network-only steps), and produces `dist/storyforge-0.1.0.zip` with a stable sha256 across two runs.
- The release documentation states the guarantees above word for word.
- The licence and every package's `license` field are AGPL-3.0-only.
