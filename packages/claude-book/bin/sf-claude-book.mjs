#!/usr/bin/env node
// sf-claude-book <command> --book <dir> [--framework <Claude-Book root>] [--work-id <name>] ...
// Exit codes: 0 ok, 1 refused (check errors, publish refusals), 2 usage or I/O error.
// M05-J07: the binary records receipts. Every provenance event goes through core's receipt writer for the book folder given as --book, and `publish`
// writes the scene and its receipt in one store batch. (The library, src/cli.mjs, stays free of @storyforge/core; only this entry file wires it.)
import path from 'node:path';
import { publishWithReceipt, recordProvenanceAt } from '@storyforge/core';
import { run } from '../src/cli.mjs';

const argv = process.argv.slice(2);
const bookArg = argv.find((a, i) => a === '--book' && argv[i + 1] !== undefined) ? argv[argv.indexOf('--book') + 1] : (argv.find((a) => a.startsWith('--book='))?.slice('--book='.length) ?? null);
const bookRoot = bookArg ? path.resolve(bookArg) : null;

process.exitCode = await run(
  argv,
  bookRoot
    ? {
        provenance: (event) => recordProvenanceAt(bookRoot, event).then(() => {}, () => {}),
        publishFile: (a) => publishWithReceipt(a.bookRoot, a),
      }
    : {},
);
