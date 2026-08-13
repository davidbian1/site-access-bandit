import js from '@eslint/js';

// Browser-extension globals ESLint's built-in envs don't cover, plus the
// small set of standard browser/DOM/node globals this project actually
// touches. Kept as an explicit list rather than pulling in the `globals`
// package, in line with the project's zero-runtime-dependency approach —
// this is the only dev dependency the repo needs.
const globals = {
  chrome: 'readonly',
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  history: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  CustomEvent: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
};

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
