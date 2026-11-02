// Child process for the atomic-create test: argv[2] = JSON { root, at, input }.
// Arms a fault in 'exit' mode (process.exit(86)) and creates a book. Exit 0 means the fault point was never reached.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(path.resolve(here, '../../src/index.mjs')).href);
const store = await import(pathToFileURL(path.resolve(here, '../../../store/src/index.mjs')).href);

const { root, at, input } = JSON.parse(process.argv[2]);
const repo = core.createFsRepository(root);
store.__faults.at = at;
store.__faults.mode = 'exit';
const result = await repo.createBook(input);
process.stderr.write(`fault point ${at} was never reached; createBook returned ${JSON.stringify(result)}\n`);
process.exit(0);
