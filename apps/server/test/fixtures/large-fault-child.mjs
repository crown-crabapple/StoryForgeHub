// Child process for the M06-J03 interrupted-write tests: argv[2] = JSON { root, at, op, bookId, args }.
// Arms a store fault in 'exit' mode (process.exit(86) at the fault point, a real crash) and runs one repository operation on the large book.
// With at = null nothing is armed: the same operation runs to the end (used to learn the "all new" state). Exit 0 = ran to the end.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(path.resolve(here, '../../../../packages/core/src/index.mjs')).href);
const store = await import(pathToFileURL(path.resolve(here, '../../../../packages/store/src/index.mjs')).href);

const { root, at, op, bookId, args } = JSON.parse(process.argv[2]);
const repo = core.createFsRepository(root, { watch: false, pollMs: 0 });
let result;
if (op === 'body') {
  const scene = await repo.getScene(bookId, args.sceneId);
  if (at) {
    store.__faults.at = at;
    store.__faults.mode = 'exit';
  }
  result = await repo.updateSceneBody(bookId, args.sceneId, args.body, { baseSha256: scene.sha256 });
} else {
  if (at) {
    store.__faults.at = at;
    store.__faults.mode = 'exit';
  }
  if (op === 'move') result = await repo.moveScene(bookId, args.sceneId, { chapter: args.chapter, after: args.after });
  else if (op === 'renumber') result = await repo.renumberChapters(bookId, { step: args.step });
  else if (op === 'accept') result = await repo.decideSuggestion(bookId, args.suggestionId, { decision: 'accept' });
  else throw new Error(`unknown op ${op}`);
}
await repo.close();
if (at) process.stderr.write(`fault point ${at} was never reached; ${op} returned ${JSON.stringify(result).slice(0, 300)}\n`);
process.stdout.write(`${JSON.stringify({ ok: result?.ok ?? null, code: result?.code ?? null })}\n`);
process.exit(at ? 0 : result?.ok ? 0 : 1);
