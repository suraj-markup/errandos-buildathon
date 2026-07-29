#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, '../../../..');
const artifactPath = join(
  packageRoot,
  'test-artifacts/h094-general-mobile-automated-evidence.json',
);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'h094-general-mobile-'));
const vitestReportPath = join(temporaryDirectory, 'vitest-report.json');
const cohortFiles = [
  'lib/general-mobile/v2/android-settings-conformance.test.ts',
  'lib/general-mobile/v2/android-settings-read-only-adapter.test.ts',
  'lib/general-mobile/v2/contracts-registry.test.ts',
  'lib/general-mobile/v2/fake-adapter.test.ts',
  'lib/general-mobile/v2/read-only-companion.test.ts',
  'lib/general-mobile/v2/runner.test.ts',
  'app/api/general-mobile/v2/android-settings/route.test.ts',
];
const requirements = [
  {
    evidence: 'explains and points using only a fresh semantic reference',
    requirement: 'read_only_companion',
  },
  {
    evidence: 'covers semantic navigation and a verified local edit',
    requirement: 'instrumented_navigation_and_local_edit',
  },
  {
    evidence: 'H094-package-scope',
    requirement: 'package_scope',
  },
  {
    evidence: 'H094-package-scope',
    requirement: 'unsupported_app',
  },
  {
    evidence: 'H094-privacy',
    requirement: 'privacy_redaction',
  },
  {
    evidence: 'H094-privacy',
    requirement: 'sensitive_screen',
  },
  {
    evidence: 'H094-stale-reference',
    requirement: 'stale_references',
  },
  {
    evidence: 'H094-cancellation',
    requirement: 'cancellation',
  },
  {
    evidence: 'H094-rollback',
    requirement: 'rollback',
  },
  {
    evidence: 'H094-disabled-state',
    requirement: 'disabled_state_enforcement',
  },
  {
    evidence: 'H094-observation-freshness',
    requirement: 'observation_freshness',
  },
  {
    evidence: 'H094-zero-mutation',
    requirement: 'zero_mutation_capabilities',
  },
  {
    evidence:
      'replans once around an unexpected dialog without external side effects',
    requirement: 'recovery',
  },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 180_000,
    ...options,
  });
}

function printedCommand(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

let vitestReport;
let testResult;
let typecheckResult;
try {
  testResult = run('pnpm', [
    'exec',
    'vitest',
    'run',
    ...cohortFiles,
    '--reporter=json',
    `--outputFile=${vitestReportPath}`,
  ]);
  printedCommand(testResult);
  try {
    vitestReport = JSON.parse(readFileSync(vitestReportPath, 'utf8'));
  } catch {
    vitestReport = undefined;
  }
  typecheckResult = run('pnpm', ['exec', 'tsc', '--noEmit']);
  printedCommand(typecheckResult);

  const testsPassed = testResult.status === 0;
  const typecheckPassed = typecheckResult.status === 0;
  const requirementEvidence = requirements.map((requirement) => {
    const matchingAssertion = vitestReport?.testResults
      ?.flatMap((suite) => suite.assertionResults ?? [])
      .find((assertion) =>
        String(assertion.fullName ?? assertion.title ?? '')
          .includes(requirement.evidence));
    return {
      ...requirement,
      status: matchingAssertion?.status === 'passed' ? 'passed' : 'failed',
    };
  });
  const allRequirementsPassed = requirementEvidence.every(
    (entry) => entry.status === 'passed',
  );
  const automatedPassed =
    testsPassed && typecheckPassed && allRequirementsPassed;
  const artifact = {
    version: 1,
    gate: 'H094',
    generatedAt: new Date().toISOString(),
    scope: 'general-mobile-v2',
    automatedEvidence: {
      complete: automatedPassed,
      cohortFiles,
      requirements: requirementEvidence,
      tests: {
        passed: vitestReport?.numPassedTests ?? null,
        status: testsPassed ? 'passed' : 'failed',
        total: vitestReport?.numTotalTests ?? null,
      },
      typecheck: {
        command: 'pnpm exec tsc --noEmit',
        status: typecheckPassed ? 'passed' : 'failed',
      },
    },
    physicalEvidence: {
      complete: false,
      required: [
        'Observe com.android.settings on the designated physical Pixel.',
        'Confirm on-device restricted-screen redaction without retaining source or pixels.',
        'Exercise cancellation and rollback while a physical read-only observation is active.',
      ],
      status: 'not_run',
    },
    releaseEvidenceComplete: false,
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`H094 evidence: ${artifactPath}\n`);
  process.stdout.write(
    `Automated=${automatedPassed ? 'complete' : 'failed'}; physical=not_run\n`,
  );
  process.exitCode = automatedPassed ? 0 : 1;
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
