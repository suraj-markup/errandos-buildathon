import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextPlugin from '@next/eslint-plugin-next';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { '@next/next': nextPlugin } },
  ...compat.extends('next/core-web-vitals').map((config) => ({ ...config, files: ['apps/web/**/*.{js,jsx,ts,tsx}'] })),
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/explicit-function-return-type': 'error' } },
);