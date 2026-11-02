// Child process for the crash matrix: argv[2] = JSON { root, at, op }.
// Opens the store, arms a fault in 'exit' mode and performs the op. Expected to die with exit code 86.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { openStore, __faults } = await import(pathToFileURL(path.resolve(here, '../../src/index.mjs')).href);
const { OPS } = await import(pathToFileURL(path.resolve(here, '../helpers.mjs')).href);

const { root, at, op } = JSON.parse(process.argv[2]);
const store = await openStore(root);
__faults.at = at;
__faults.mode = 'exit';
await OPS[op].run(store);
// The fault point was never reached.
process.exit(0);
