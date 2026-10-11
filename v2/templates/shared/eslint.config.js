import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', structuredClone: 'readonly', performance: 'readonly', AbortController: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', Response: 'readonly', Request: 'readonly', Headers: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
