import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectOfflineReleaseFacts,
  evaluateOfflineReleaseGate,
  unsafeReadinessOperations,
} from '../lib/h092-h095-offline-release-gate.mjs';

function passingFacts() {
  return {
    finalEvidence: { complete: true, evidence: 'complete' },
    h092: { physicalCanary: 'passed', preflight: 'allowed' },
    h093: { complete: true, evidence: 'complete' },
    h094: {
      automated: true,
      automatedEvidence: 'passed',
      physical: true,
      physicalEvidence: 'passed',
    },
    h095: { complete: true, evidence: 'complete' },
    modelPolicy: {
      aggregateUsageTelemetry: true,
      costBoundsAligned: true,
      costEvidence: 'aligned',
      fallbackEvidence: 'declared',
      fallbackRegressionsDeclared: true,
      usageEvidence: 'present',
    },
    readinessProbeUnsafeOperations: [],
    rollback: { evidence: 'declared', regressionsDeclared: true },
  };
}

test('allows only a complete definition-of-done snapshot', () => {
  const result = evaluateOfflineReleaseGate(passingFacts());
  assert.equal(result.releaseReady, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.length, 12);
});
test('fails closed for every independently missing release fact', () => {
  const cases = [
    ['readiness_probe_is_non_mutating', (facts) => {
      facts.readinessProbeUnsafeOperations = ['1:device_input'];
    }],
    ['h092_machine_preflight_allowed', (facts) => {
      facts.h092.preflight = 'refused';
    }],
    ['h092_physical_canary_passed', (facts) => {
      facts.h092.physicalCanary = 'not_passed';
    }],
    ['h093_separate_authorization_and_cod_evidence', (facts) => {
      facts.h093.complete = false;
    }],
    ['h094_automated_cohort_passed', (facts) => {
      facts.h094.automated = false;
    }],
    ['h094_physical_read_only_cohort_passed', (facts) => {
      facts.h094.physical = false;
    }],
    ['h095_convergence_audit_passed', (facts) => {
      facts.h095.complete = false;
    }],
    ['rollback_regressions_declared', (facts) => {
      facts.rollback.regressionsDeclared = false;
    }],
    ['model_cost_bounds_aligned', (facts) => {
      facts.modelPolicy.costBoundsAligned = false;
    }],
    ['bounded_fallback_regressions_declared', (facts) => {
      facts.modelPolicy.fallbackRegressionsDeclared = false;
    }],
    ['aggregate_model_usage_telemetry_present', (facts) => {
      facts.modelPolicy.aggregateUsageTelemetry = false;
    }],
    ['final_evidence_index_complete', (facts) => {
      facts.finalEvidence.complete = false;
    }],
  ];
  for (const [expectedBlocker, mutate] of cases) {
    const facts = structuredClone(passingFacts());
    mutate(facts);
    const result = evaluateOfflineReleaseGate(facts);
    assert.equal(result.releaseReady, false);
    assert.deepEqual(result.blockers, [expectedBlocker]);
  }
});

test('detects mutating device, HTTP, bridge, and host commands', () => {
  const source = [
    'adb -s serial shell input tap 1 2',
    'adb -s serial shell am start -n package/.Main',
    'adb -s serial reverse tcp:3100 tcp:3100',
    'curl -X POST http://127.0.0.1/task',
    'rm artifact.json',
  ].join('\n');
  assert.deepEqual(unsafeReadinessOperations(source), [
    '1:device_input',
    '2:app_launch',
    '3:reverse_mapping_change',
    '4:http_mutation',
    '5:host_mutation',
  ]);
  assert.deepEqual(unsafeReadinessOperations([
    'adb -s serial reverse --list',
    'adb -s serial shell dumpsys power',
    'curl --max-time 3 http://127.0.0.1/status',
  ].join('\n')), []);
});

test('current repository report remains honest about incomplete live gates', () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(testDirectory, '../../..');
  const result = evaluateOfflineReleaseGate(
    collectOfflineReleaseFacts(repoRoot),
  );
  assert.equal(result.releaseReady, false);
  assert.equal(
    result.checks.find(({ name }) =>
      name === 'readiness_probe_is_non_mutating')?.status,
    'passed',
  );
  assert.equal(
    result.checks.find(({ name }) =>
      name === 'h094_automated_cohort_passed')?.status,
    'passed',
  );
  assert.ok(result.blockers.includes('h092_physical_canary_passed'));
  assert.ok(
    result.blockers.includes(
      'h093_separate_authorization_and_cod_evidence',
    ),
  );
  assert.ok(result.blockers.includes('final_evidence_index_complete'));
});
