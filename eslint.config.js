import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
    {
        ignores: ['node_modules/**', 'resources/**', 'data/**', 'backup/**', 'temp/**', 'dist-resources/**', '**/*.d.ts'],
    },
    js.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            // Input sanitizers intentionally match control characters.
            'no-control-regex': 'off',
            // Cloud and credential errors are rethrown without `cause` so tokens never reach logs.
            'preserve-caught-error': 'off',
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
        },
    },
    {
        files: ['**/*.cjs'],
        languageOptions: { sourceType: 'commonjs' },
    },
    prettier,
]
