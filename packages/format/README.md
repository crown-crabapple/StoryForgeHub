# @storyforge/format

Validator for the StoryForge Markdown format v1. Reads a project folder (book, series or library), puts every scene in book order, resolves links, and reports diagnostics. Read-only; ignores `.storyforge/`.

- Format spec: `storyforge-v2-production-plan/spec/FORMAT-v1.md` (the diagnostic code table is its section 11)
- API and implementation decisions: [CONTRACT.md](CONTRACT.md)

## API

```js
import { validate } from '@storyforge/format';
const { diagnostics, books } = await validate('/path/to/book-or-series-or-library');
```

`diagnostics` is sorted by file, then location, then code, with each (code, file, location) once. `books` holds, per book, its scene `order`, `excluded` files and chronological `timeline`. Bad files become diagnostics, not exceptions; only a `rootDir` that is not a directory throws.

## CLI

```text
sf-validate <path> [--json]
```

Prints one diagnostic per line (`CODE severity file location message`), or the full result as JSON. Exit code 1 if any error, 0 otherwise, 2 on a usage error.

## Tests

`npm test` (Node built-in runner).
