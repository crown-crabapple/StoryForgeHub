// Child process for the M03-J02 interrupted-save test: argv[2] = JSON { root, at, bookId, sceneId, body, baseSha256 }.
// Arms a store fault in 'exit' mode (process.exit(86)) and saves a scene body through the repository,
// exactly as PUT /api/books/:b/scenes/:s/body does. Exit 0 means the fault point was never reached.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(path.resolve(here, '../../../../packages/core/src/index.mjs')).href);
const store = await import(pathToFileURL(path.resolve(here, '../../../../packages/store/src/index.mjs')).href);

const { root, at, bookId, sceneId, body, baseSha256 } = JSON.parse(process.argv[2]);
const repo = core.createFsRepository(root);
store.__faults.at = at;
store.__faults.mode = 'exit';
const result = await repo.updateSceneBody(bookId, sceneId, body, { baseSha256 });
process.stderr.write(`fault point ${at} was never reached; updateSceneBody returned ${JSON.stringify(result)}\n`);
process.exit(0);
