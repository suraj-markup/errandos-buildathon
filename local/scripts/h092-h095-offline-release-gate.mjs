#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectOfflineReleaseFacts,
  evaluateOfflineReleaseGate,
} from './lib/h092-h095-offline-release-gate.mjs';

const mode = process.argv[2] ?? '--report';
if (!['--check', '--report'].includes(mode) || process.argv.length > 3) {
  process.stderr.write(
    'Usage: node local/scripts/h092-h095-offline-release-gate.mjs [--report|--check]\n',
  );
  process.exit(2);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '../..');
const result = evaluateOfflineReleaseGate(
  collectOfflineReleaseFacts(repoRoot),
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (mode === '--check' && !result.releaseReady) process.exit(1);
