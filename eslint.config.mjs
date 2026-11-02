import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const FS_MODULES = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'];
const fsPaths = FS_MODULES.map((name) => ({
  name,
  message:
    'Filesystem access is restricted: writes only in packages/store/src; reads in packages/format, packages/templates/src (its own template folder), packages/core/src/fs-repository.mjs and apps/server/src/static.mjs.',
}));

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

  // packages/continuity: read-only; it reads the book through @storyforge/format and never touches the filesystem itself.
  {
    files: ['packages/continuity/src/**/*.mjs'],
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

  // M00 packages predate this config and are frozen in this job; relax the rules they trip.
  {
    files: ['packages/format/**/*.mjs', 'packages/manuscript/**/*.mjs'],
    rules: { 'no-useless-assignment': 'off', 'no-control-regex': 'off', 'no-unused-vars': 'off' },
  },
];
