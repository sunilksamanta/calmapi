import js from '@eslint/js';

const node = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  fetch: 'readonly', FormData: 'readonly', Blob: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', structuredClone: 'readonly',
  performance: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  Response: 'readonly', Request: 'readonly', Headers: 'readonly',
};
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', location: 'readonly',
  EventSource: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly', HTMLElement: 'readonly',
  Event: 'readonly', KeyboardEvent: 'readonly', CustomEvent: 'readonly', AbortController: 'readonly', Blob: 'readonly',
  TextDecoder: 'readonly', performance: 'readonly', history: 'readonly', DOMParser: 'readonly', structuredClone: 'readonly',
  queueMicrotask: 'readonly', Intl: 'readonly', Node: 'readonly', CSS: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly', alert: 'readonly',
};

export default [
  { ignores: ['registry/r/**', 'node_modules/**', '**/node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-control-regex': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['packages/devtools/ui/**/*.js'],
    languageOptions: { globals: browser },
  },
];
