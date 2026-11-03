import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const FS_MODULES = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'];
const fsPaths = FS_MODULES.map((name) => ({
  name,
  message:
    'Filesystem access is restricted: writes only in packages/store/src; reads in packages/format, packages/templates/src (its own template folder), packages/core/src/fs-repository.mjs and apps/server/src/static.mjs.',
}));

// M05-J04: outbound network I/O exists in ONE place, packages/ai/src/transport.mjs. Everywhere else in packages/** and apps/server/** these are errors:
// the globals fetch / WebSocket (also as globalThis.x), node:https, node:net, node:tls, node:dgram, node:http2, undici, and node:http except
// http.createServer in apps/server/src/server.mjs. Tests are exempt (they start mock servers and call the API under test).
const NET_MESSAGE = 'Outbound network I/O is only allowed in packages/ai/src/transport.mjs (use postJson from @storyforge/ai).';
const NET_MODULE_RE = '^((node:)?(https|http2|net|tls|dgram)|undici)$';
const HTTP_MODULE_RE = '^(node:)?http$';
const moduleSelectors = (re, message) => [
  ...['ImportDeclaration', 'ImportExpression', 'ExportNamedDeclaration', 'ExportAllDeclaration'].map((type) => ({ selector: `${type}[source.value=/${re}/]`, message })),
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/${re}/]`, message },
];
const NET_SELECTORS = moduleSelectors(NET_MODULE_RE, NET_MESSAGE);
const NO_HTTP_SELECTORS = moduleSelectors(HTTP_MODULE_RE, NET_MESSAGE);
// the narrow allowance for apps/server/src/server.mjs: node:http may be imported, but only to create the server
const HTTP_CLIENT_SELECTORS = [
  { selector: "ImportDeclaration[source.value=/^(node:)?http$/] > ImportSpecifier[imported.name=/^(request|get)$/]", message: NET_MESSAGE },
  { selector: "MemberExpression[object.name='http'][property.name=/^(request|get)$/]", message: NET_MESSAGE },
  { selector: "MemberExpression[object.name='http'][computed=true]", message: NET_MESSAGE },
];
const SQLITE_MESSAGE = 'node:sqlite is only for packages/index/src. Use @storyforge/index.';
const SQLITE_SELECTORS = [
  { selector: 'ImportDeclaration[source.value=/^(node:)?sqlite$/]', message: SQLITE_MESSAGE },
  { selector: 'ImportExpression[source.value=/^(node:)?sqlite$/]', message: SQLITE_MESSAGE },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?sqlite$/]", message: SQLITE_MESSAGE },
];
const NET_GLOBALS = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'].map((name) => ({ name, message: NET_MESSAGE }));
const NET_PROPERTIES = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'].flatMap((property) =>
  ['globalThis', 'global', 'self', 'window'].map((object) => ({ object, property, message: NET_MESSAGE })),
);
const FS_WRITE_FNS = '^(write[A-Za-z]*|append[A-Za-z]*|mkdir[A-Za-z]*|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|open|openSync|truncate|truncateSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|utimes|utimesSync)$';
const NET_SCOPE =['packages/**/*.mjs', 'apps/server/**/*.mjs'];
const NET_IGNORES = ['**/test/**', 'packages/ai/src/transport.mjs', 'apps/server/src/server.mjs'];
const networkPaths = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'http', 'https', 'net', 'tls', 'dns'].map((name) => ({
  name,
  message: 'The Claude-Book adapter is local only: no network.',
}));
const processPaths = ['node:child_process', 'child_process'].map((name) => ({
  name,
  message: 'Only packages/claude-book/src/style.mjs starts a process (the Claude-Book style checker).',
}));

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'packages/format/fixtures/**', 'packages/manuscript/fixtures/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.jsx', '**/*.js'],
    ignores: ['scripts/**'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.flat.recommended.rules },
  },

  // apps/web: browser code. No Node built-ins and no workspace packages; it only calls /api.
  {
    files: ['apps/web/**/*.{js,jsx,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Bare names only; `node:*` is covered once by the pattern below.
          paths: ['fs', 'fs/promises', 'path'].map((name) => ({ name, message: 'The web app cannot use Node modules.' })),
          patterns: [
            { group: ['node:*'], message: 'The web app cannot use Node modules.' },
            { group: ['@storyforge/*'], message: 'The web app talks to the server over /api only.' },
          ],
        },
      ],
    },
  },

  // apps/web tests run in Node (node:test, node:fs); they still must not reach into workspace packages.
  {
    files: ['apps/web/test/**/*.mjs'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@storyforge/*'], message: 'The web app talks to the server over /api only.' }] }],
    },
  },

  // apps/server: routes go through the FileRepository; static.mjs is the one exception (reads only).
  // Tests are exempt: they copy fixtures to temp folders.
  {
    files: ['apps/server/**/*.mjs'],
    ignores: ['apps/server/src/static.mjs', 'apps/server/test/**'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },

  // packages/core: only fs-repository.mjs reads files (no write calls; enforced by a test). All
  // writes go through @storyforge/store, the only package that writes project files.
  {
    files: ['packages/core/src/**/*.mjs'],
    ignores: ['packages/core/src/fs-repository.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },

  // packages/manuscript: no direct filesystem access; reads and writes go through @storyforge/store.
  // (bin/ is the CLI shell and may read its own arguments, e.g. --body-file.)
  {
    files: ['packages/manuscript/src/**/*.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },

  // packages/export (M05-J03) reads book folders directly (export and backup only read) and has no fs restriction of its own; every write it
  // causes (a restored backup, an output file) goes through @storyforge/store (writeNewTree, writeOutFile). It never imports node:sqlite (rule below).
  // packages/continuity: read-only; it reads the book through @storyforge/format and never touches the filesystem itself.
  {
    files: ['packages/continuity/src/**/*.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },

  // packages/suggestions (M05-J06): pure; builds, parses and applies suggestion text. No filesystem access.
  {
    files: ['packages/suggestions/src/**/*.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },

  // packages/receipts (M05-J07): pure; builds, parses, diffs and verifies receipt text. No filesystem access (core writes through the store).
  {
    files: ['packages/receipts/src/**/*.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },

  // packages/ai: no direct filesystem access; settings go through the store's user-config functions.
  {
    files: ['packages/ai/src/**/*.mjs'],
    ignores: ['packages/ai/src/keystore.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: [...fsPaths, ...processPaths.map((p) => ({ ...p, message: 'In packages/ai only src/keystore.mjs starts a process (the OS key store).' }))] }] },
  },
  // M08-J03: the key store may start the OS key-store tools; it still has no direct filesystem access (secrets.json goes through @storyforge/store)
  {
    files: ['packages/ai/src/keystore.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },
  // packages/shared (M07-J03): no direct filesystem access; the shared-data files go through the store's shared-file functions.
  {
    files: ['packages/shared/src/**/*.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: fsPaths }] },
  },
  // packages/claude-book: the local Claude-Book adapter. Only src/io.mjs touches the filesystem (every write is checked
  // to stay inside <framework>/.work/<work-id>/); only src/style.mjs starts a process (the style checker); no network.
  {
    files: ['packages/claude-book/src/**/*.mjs'],
    ignores: ['packages/claude-book/src/io.mjs', 'packages/claude-book/src/style.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: [...fsPaths, ...networkPaths, ...processPaths] }] },
  },
  {
    files: ['packages/claude-book/src/io.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: [...networkPaths, ...processPaths] }] },
  },
  {
    files: ['packages/claude-book/src/style.mjs'],
    rules: { 'no-restricted-imports': ['error', { paths: [...fsPaths, ...networkPaths] }] },
  },

  // node:sqlite belongs to the index package alone (its tests may open the database to check tables).
  // Uses no-restricted-syntax so it is not overridden by the per-folder no-restricted-imports blocks.
  {
    files: ['**/*.{mjs,js,jsx}'],
    ignores: ['packages/index/src/**', 'packages/index/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value=/^(node:)?sqlite$/]",
          message: 'node:sqlite is only for packages/index/src. Use @storyforge/index.',
        },
        {
          selector: "ImportExpression[source.value=/^(node:)?sqlite$/]",
          message: 'node:sqlite is only for packages/index/src. Use @storyforge/index.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?sqlite$/]",
          message: 'node:sqlite is only for packages/index/src. Use @storyforge/index.',
        },
      ],
    },
  },

  // M05-J04: no outbound network outside packages/ai/src/transport.mjs. These blocks restate the node:sqlite selectors because a later
  // no-restricted-syntax setting replaces the earlier one (packages/index keeps its own freedom to use node:sqlite).
  {
    files: NET_SCOPE,
    ignores: [...NET_IGNORES, 'packages/index/**'],
    rules: {
      'no-restricted-globals': ['error', ...NET_GLOBALS],
      'no-restricted-properties': ['error', ...NET_PROPERTIES],
      'no-restricted-syntax': ['error', ...SQLITE_SELECTORS, ...NET_SELECTORS, ...NO_HTTP_SELECTORS],
    },
  },
  {
    files: ['packages/index/**/*.mjs'],
    ignores: NET_IGNORES,
    rules: {
      'no-restricted-globals': ['error', ...NET_GLOBALS],
      'no-restricted-properties': ['error', ...NET_PROPERTIES],
      'no-restricted-syntax': ['error', ...NET_SELECTORS, ...NO_HTTP_SELECTORS],
    },
  },
  {
    // the one http exception: createServer in the server entry file
    files: ['apps/server/src/server.mjs'],
    rules: {
      'no-restricted-globals': ['error', ...NET_GLOBALS],
      'no-restricted-properties': ['error', ...NET_PROPERTIES],
      'no-restricted-syntax': ['error', ...SQLITE_SELECTORS, ...NET_SELECTORS, ...HTTP_CLIENT_SELECTORS],
    },
  },

  // M06-J01: packages/legacy-import only reads a legacy dump (planning, never writing). It may read files; it may not call a write function.
  // (Restates the sqlite and network selectors because a later no-restricted-syntax setting replaces the earlier one.)
  {
    files: ['packages/legacy-import/src/**/*.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SQLITE_SELECTORS,
        ...NET_SELECTORS,
        ...NO_HTTP_SELECTORS,
        {
          selector: `ImportDeclaration[source.value=/^(node:)?fs(\\/promises)?$/] > ImportSpecifier[imported.name=/${FS_WRITE_FNS}/]`,
          message: 'The legacy importer only reads (planning). Writes belong to the store (the CLI writes its report through @storyforge/store).',
        },
        {
          selector: `MemberExpression[object.name=/^(fs|fsp|promises)$/][property.name=/${FS_WRITE_FNS}/]`,
          message: 'The legacy importer only reads (planning). Writes belong to the store (the CLI writes its report through @storyforge/store).',
        },
      ],
    },
  },

  // M00 packages predate this config and are frozen in this job; relax the rules they trip.
  {
    files: ['packages/format/**/*.mjs', 'packages/manuscript/**/*.mjs'],
    rules: { 'no-useless-assignment': 'off', 'no-control-regex': 'off', 'no-unused-vars': 'off' },
  },
];
