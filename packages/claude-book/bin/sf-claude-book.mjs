#!/usr/bin/env node
// sf-claude-book <command> --book <dir> [--framework <Claude-Book root>] [--work-id <name>] ...
// Exit codes: 0 ok, 1 refused (check errors, publish refusals), 2 usage or I/O error.
import { run } from '../src/cli.mjs';

process.exitCode = await run(process.argv.slice(2));
