# Security policy

## Supported versions

Security fixes go to the latest released minor version (for example 0.1.x while 0.1 is current). Before 1.0 there is no longer-term support: upgrade to the latest release. A fix is published as a patch release with a note in the [changelog](CHANGELOG.md).

## Reporting a vulnerability

Please report privately, not in a public issue or pull request.

Send a message to `<ADD CONTACT>` with:

- what you found and where (the version, the mode: personal, shared or Docker, and the route or command);
- the steps to reproduce it, using a throwaway library: please do not send real manuscript text, passwords or tokens;
- what you think an attacker could do.

You can expect an acknowledgement within a few days and a plan for a fix or a reason it is not one. Please give us a reasonable time to release a fix before you publish details. We will credit you in the changelog if you wish.

## The shared-mode threat model, in short

Personal mode listens on `127.0.0.1` only, has no accounts and no authentication routes: the protection is that only programs on your computer can reach it, and that the server refuses requests from other addresses, with the wrong `Host` header, or (for writes) that do not come from the app's own pages.

Shared mode (optional, for a group on a server you run) adds accounts, roles (owner, editor, reviewer, viewer), read-only share links, an audit log and rate limits.

What it is designed to withstand:

- someone without an account: they reach only the public health probe and the login and setup routes, and every other call is refused and audited;
- a member trying to do more than their role allows (the policy lists every write route by class and a test sweeps about 700 refused calls);
- a share link holder: they can read only their book's text and cover, and export when the link allows it;
- a plugin: tokens carry only read, propose or events permissions, never write; a proposal becomes a suggestion that the author must accept; a plugin cannot point a webhook at the local machine;
- two people editing at once: a stale save is refused (`409 STALE`) and the losing text is kept as a suggestion;
- a stolen shared-data folder: passwords are stored only as salted hashes, session and plugin tokens only as hashes, and the audit log is a hash chain with a head anchor, so edits and truncation are detected.

What it does not claim:

- The audit chain detects accidental or naive tampering; someone who can write to the shared-data folder can rewrite the log and its head together.
- Run shared mode behind HTTPS (a reverse proxy; see [docs/self-hosting.md](docs/self-hosting.md)). Without it, passwords and cookies cross the network in the clear.
- Behind a proxy the per-address login limit counts the proxy as one client; the per-username limit still applies.
- StoryForge cannot protect a computer that is already compromised, or a library folder that other people can read and write on disk.
- Receipts are a tamper-evident record, not a legal finding.

## In scope

- the StoryForge server, command line and web app in this repository;
- the Docker, systemd and Caddy files in `deploy/` as shipped;
- the release zip and its checksum;
- bypasses of roles, share links, plugin tokens, the loopback, `Host` and own-page checks, or the audit chain;
- reading or writing files outside a library, path traversal, and leaks of passwords, tokens or manuscript text into logs, receipts, exports or webhooks;
- anything that makes StoryForge send data off the computer without the author's explicit action.

## Out of scope

- problems that need an attacker who already has access to the computer account running StoryForge, or write access to the library or shared-data folders;
- running shared mode over plain HTTP on an untrusted network, or on a server you have not hardened;
- the third-party AI providers an author chooses, and plugins an author chooses to run (a plugin is a separate program and can only lose its own token);
- denial of service from a very large library on slow hardware, and flooding a public instance with refused requests (it grows the audit log; see the known limits in the release notes);
- missing features, and issues in dependencies that are already fixed in a newer release (tell us if StoryForge pins a vulnerable one).
