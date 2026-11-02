#!/usr/bin/env node
// sf-claude-book <context|style|review-request> --book <dir> --framework <Claude-Book root> [--work-id <name>] ...
// Exit codes: 0 ok, 2 usage or I/O error (1 is reserved for `check`, M05-J06).
import { run } from '../src/cli.mjs';

process.exitCode = await run(process.argv.slice(2));
