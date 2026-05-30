// Flat ESLint config. The repo is `"type": "module"`, so every `.js` is ESM
// and the single `.cjs` preload is CommonJS — each gets its own globals/source
// type below. Renderer files are browser + JSX + React.
//
// react-hooks is pinned to its two CLASSIC rules (rules-of-hooks + exhaustive-
// deps). react-hooks v7's `recommended` set also enables newer React-Compiler-
// era rules (set-state-in-effect, immutability) that flag idiomatic patterns
// this codebase uses deliberately — they were reviewed and intentionally left
// off. exhaustive-deps is a `warn` because it has known false positives on the
// stable-ref pattern used throughout; genuinely-intentional omissions carry an
// inline disable with a reason.
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'build/**', '.git/**'] },

  js.configs.recommended,

  // Main process, shared constants, tests — Node, ESM (JS or TS).
  {
    files: ['src/main/**/*.{js,ts}', 'src/shared/**/*.{js,ts}', 'tests/**/*.js'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Preload bridge — Node, CommonJS.
  {
    files: ['src/preload/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Renderer — browser + JSX + React (JS or TS).
  {
    files: ['src/renderer/**/*.{js,jsx,ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      // React 19 automatic JSX runtime — these two are obsolete.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      // Cosmetic; apostrophes/quotes in JSX text are fine.
      'react/no-unescaped-entities': 'off',
      // Classic react-hooks rules only (see header note).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // TS source files: drop core no-undef (TypeScript handles undefined names,
  // and no-undef flags type-only globals). tsc --noEmit is the type gate.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
