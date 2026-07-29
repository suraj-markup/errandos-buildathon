import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeDeadCodeV1,
  type DeadCodeConfigV1,
  type DeadCodeManifestV1,
} from './analyzer';

const roots: string[] = [];
const config: DeadCodeConfigV1 = {
  version: 1,
  sourcePatterns: ['app/**/*.ts', 'lib/**/*.ts', 'scripts/**/*.ts'],
  productionEntrypoints: ['app/**/route.ts'],
  testEntrypoints: ['**/*.test.ts'],
  scriptEntrypoints: ['scripts/**/*.ts'],
  exceptionManifest: 'exceptions.json',
};

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'voice-dead-code-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, source, 'utf8');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

const emptyManifest: DeadCodeManifestV1 = {
  version: 1,
  exceptions: [],
};

describe('voice dead-code analyzer', () => {
  it('separates production, test-only, script-only, and unreachable files', async () => {
    const rootDir = await fixture({
      'app/api/route.ts': "import { live } from '../../lib/live'; export const GET = () => live();",
      'lib/live.ts': 'export const live = () => 1; export const unused = 2;',
      'lib/test-helper.ts': 'export const helper = 1;',
      'lib/script-helper.ts': 'export const scriptHelper = 1;',
      'lib/orphan.ts': 'export const orphan = 1;',
      'lib/live.test.ts': "import { helper } from './test-helper'; void helper;",
      'scripts/run.ts': "import { scriptHelper } from '../lib/script-helper'; void scriptHelper;",
    });
    const report = await analyzeDeadCodeV1({
      rootDir,
      config,
      manifest: emptyManifest,
      today: '2026-07-28',
    });

    expect(report.reachability.production).toEqual([
      'app/api/route.ts',
      'lib/live.ts',
    ]);
    expect(report.reachability.testOnly).toEqual([
      'lib/live.test.ts',
      'lib/test-helper.ts',
    ]);
    expect(report.reachability.scriptOnly).toEqual([
      'lib/script-helper.ts',
      'scripts/run.ts',
    ]);
    expect(report.findings).toEqual([
      { kind: 'export', target: 'lib/live.ts#unused' },
      { kind: 'file', target: 'lib/orphan.ts' },
    ]);
  });

  it('supports reviewed exceptions and rejects stale or expired entries', async () => {
    const rootDir = await fixture({
      'app/api/route.ts': 'export const GET = () => 1;',
      'lib/flagged.ts': 'export const future = 1;',
    });
    const manifest: DeadCodeManifestV1 = {
      version: 1,
      exceptions: [{
        kind: 'file',
        target: 'lib/flagged.ts',
        category: 'feature_flag',
        owner: 'voice-platform',
        removeBy: '2026-08-15',
        reason: 'Waiting for the guarded rollout window.',
      }],
    };
    const report = await analyzeDeadCodeV1({
      rootDir,
      config,
      manifest,
      today: '2026-07-28',
    });
    expect(report.suppressed).toHaveLength(1);
    expect(report.violations).toEqual([]);
    expect(report.manifestErrors).toEqual([]);

    const invalid = await analyzeDeadCodeV1({
      rootDir,
      config,
      manifest: {
        version: 1,
        exceptions: [
          { ...manifest.exceptions[0]!, removeBy: '2026-07-01' },
          {
            ...manifest.exceptions[0]!,
            target: 'lib/no-longer-dead.ts',
          },
        ],
      },
      today: '2026-07-28',
    });
    expect(invalid.manifestErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('expired'),
      expect.stringContaining('Stale exception'),
    ]));
  });

  it('supports exact grouped exceptions without hiding new findings', async () => {
    const rootDir = await fixture({
      'app/api/route.ts': 'export const GET = () => 1;',
      'lib/compat-a.ts': 'export const legacyA = 1;',
      'lib/compat-b.ts': 'export const legacyB = 1;',
      'lib/new-orphan.ts': 'export const newOrphan = 1;',
    });
    const manifest: DeadCodeManifestV1 = {
      version: 1,
      exceptions: [{
        category: 'compatibility',
        owner: 'voice-platform',
        removeBy: '2026-08-15',
        reason: 'Retained until compatibility callers migrate.',
        findings: [
          { kind: 'file', target: 'lib/compat-a.ts' },
          { kind: 'file', target: 'lib/compat-b.ts' },
        ],
      }],
    };
    const report = await analyzeDeadCodeV1({
      rootDir,
      config,
      manifest,
      today: '2026-07-28',
    });

    expect(report.suppressed.map(({ finding }) => finding)).toEqual([
      { kind: 'file', target: 'lib/compat-a.ts' },
      { kind: 'file', target: 'lib/compat-b.ts' },
    ]);
    expect(report.violations).toEqual([
      { kind: 'file', target: 'lib/new-orphan.ts' },
    ]);
    expect(report.manifestErrors).toEqual([]);
  });

  it('requires exception removal dates within 90 days', async () => {
    const rootDir = await fixture({
      'app/api/route.ts': 'export const GET = () => 1;',
      'lib/compat.ts': 'export const legacy = 1;',
    });
    const report = await analyzeDeadCodeV1({
      rootDir,
      config,
      manifest: {
        version: 1,
        exceptions: [{
          kind: 'file',
          target: 'lib/compat.ts',
          category: 'compatibility',
          owner: 'voice-platform',
          removeBy: '2027-01-01',
          reason: 'Retained until compatibility callers migrate.',
        }],
      },
      today: '2026-07-28',
    });

    expect(report.manifestErrors).toContain(
      'Exception 0 removeBy must be within 90 days.',
    );
  });

  it('returns deterministically sorted findings', async () => {
    const rootDir = await fixture({
      'app/api/route.ts': 'export const GET = () => 1;',
      'lib/z.ts': 'export const z = 1;',
      'lib/a.ts': 'export const a = 1;',
    });
    const input = {
      rootDir,
      config,
      manifest: emptyManifest,
      today: '2026-07-28',
    };
    const first = await analyzeDeadCodeV1(input);
    const second = await analyzeDeadCodeV1(input);

    expect(first).toEqual(second);
    expect(first.findings.map(({ target }) => target)).toEqual([
      'lib/a.ts',
      'lib/z.ts',
    ]);
  });
});
