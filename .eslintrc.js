'use strict'

module.exports = {
  root: true,
  settings: {
    'import/resolver': {
      typescript: {},
      node: {
        extensions: [
          '.js',
          '.jsx',
          '.ts',
          '.tsx'
        ]
      }
    }
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname
  },
  plugins: [
    '@typescript-eslint',
    'import'
  ],
  extends: [
    'ipfs'
  ],
  ignorePatterns: [
    '**/lib/**',
    '**/dist/**',
    '**/node_modules/**'
  ],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/consistent-type-assertions': 'off',
    '@typescript-eslint/strict-boolean-expressions': 'off',
    'no-void': 'off',
    'no-continue': 'off',
    'complexity': 'off',
    'quote-props': 'off',
  }
};
