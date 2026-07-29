import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const requiredReleaseChecks = Object.freeze([
  'readiness_probe_is_non_mutating',
  'h092_machine_preflight_allowed',
  'h092_physical_canary_passed',
  'h093_separate_authorization_and_cod_evidence',
  'h094_automated_cohort_passed',
  'h094_physical_read_only_cohort_passed',
  'h095_convergence_audit_passed',
  'rollback_regressions_declared',
  'model_cost_bounds_aligned',
  'bounded_fallback_regressions_declared',
  'aggregate_model_usage_telemetry_present',
  'final_evidence_index_complete',
]);

function check(name, passed, evidence) {
  return {
    evidence,
    name,
    status: passed ? 'passed' : 'blocked',
  };
}

export function evaluateOfflineReleaseGate(facts) {
  const checks = [
    check(
      'readiness_probe_is_non_mutating',
      facts.readinessProbeUnsafeOperations.length === 0,
      facts.readinessProbeUnsafeOperations.length === 0
        ? 'static command audit found no mutating operation'
        : facts.readinessProbeUnsafeOperations.join(','),
    ),
    check(
      'h092_machine_preflight_allowed',
      facts.h092.preflight === 'allowed',
      `preflight=${facts.h092.preflight}`,
    ),
    check(
      'h092_physical_canary_passed',
      facts.h092.physicalCanary === 'passed',
      `physicalCanary=${facts.h092.physicalCanary}`,
    ),
    check(
      'h093_separate_authorization_and_cod_evidence',
      facts.h093.complete,
      facts.h093.evidence,
    ),
    check(
      'h094_automated_cohort_passed',
      facts.h094.automated,
      facts.h094.automatedEvidence,
    ),
    check(
      'h094_physical_read_only_cohort_passed',
      facts.h094.physical,
      facts.h094.physicalEvidence,
    ),
    check(
      'h095_convergence_audit_passed',
      facts.h095.complete,
      facts.h095.evidence,
    ),
    check(
      'rollback_regressions_declared',
      facts.rollback.regressionsDeclared,
      facts.rollback.evidence,
    ),
    check(
      'model_cost_bounds_aligned',
      facts.modelPolicy.costBoundsAligned,
      facts.modelPolicy.costEvidence,
    ),
    check(
      'bounded_fallback_regressions_declared',
      facts.modelPolicy.fallbackRegressionsDeclared,
      facts.modelPolicy.fallbackEvidence,
    ),
    check(
      'aggregate_model_usage_telemetry_present',
      facts.modelPolicy.aggregateUsageTelemetry,
      facts.modelPolicy.usageEvidence,
    ),
    check(
      'final_evidence_index_complete',
      facts.finalEvidence.complete,
      facts.finalEvidence.evidence,
    ),
  ];
  const blockers = checks
    .filter(({ status }) => status === 'blocked')
    .map(({ name }) => name);
  return {
    blockers,
    checks,
    releaseReady:
      checks.length === requiredReleaseChecks.length
      && requiredReleaseChecks.every((name) =>
        checks.some((entry) => entry.name === name && entry.status === 'passed')),
    version: 1,
  };
}

export function unsafeReadinessOperations(source) {
  const unsafe = [];
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const command = line.replace(/^["']|["']$/gu, '');
    const reasons = [
      [/\badb\b.*\bshell\b.*\b(input|monkey)\b/u, 'device_input'],
      [/\badb\b.*\bshell\b.*\bam\s+start\b/u, 'app_launch'],
      [/\badb\b.*\bshell\b.*\b(settings\s+put|pm\s+grant|appops\s+set)\b/u, 'device_setting_change'],
      [/\badb\b.*\breverse\b(?!\s+--list\b)/u, 'reverse_mapping_change'],
      [/\bcurl\b.*(?:--data|-d(?:\s|$)|--request|-X)\s*(?:POST|PUT|PATCH|DELETE)?/u, 'http_mutation'],
      [/^(?:rm|mv|cp|install|kill|pkill)\b/u, 'host_mutation'],
    ];
    for (const [pattern, reason] of reasons) {
      if (pattern.test(command)) unsafe.push(`${index + 1}:${reason}`);
    }
  }
  return unsafe;
}

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function json(path) {
  try {
    return JSON.parse(read(path));
  } catch {
    return undefined;
  }
}

function productionSources(directory) {
  if (!existsSync(directory)) return '';
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return productionSources(path);
      if (
        !entry.isFile()
        || /\.test\.[cm]?[jt]sx?$/u.test(entry.name)
        || !/\.[cm]?[jt]sx?$/u.test(entry.name)
      ) {
        return [];
      }
      return [read(path)];
    })
    .join('\n');
}

function h093Evidence(path) {
  const value = json(path);
  const complete = Boolean(
    value
    && value.status === 'passed'
    && typeof value.authorizationReference === 'string'
    && value.authorizationReference.length > 0
    && value.dispatchCount === 1
    && value.duplicateDispatchCount === 0
    && value.receiptVerified === true
    && value.reconciliationVerified === true,
  );
  return {
    complete,
    evidence: complete
      ? 'separate authorization, one dispatch, receipt, and reconciliation recorded'
      : 'missing or incomplete H093 COD evidence artifact',
  };
}

function finalEvidence(path) {
  const value = json(path);
  const complete = Boolean(
    value
    && value.status === 'passed'
    && typeof value.commit === 'string'
    && typeof value.serverIdentity === 'string'
    && typeof value.apkSha256 === 'string'
    && value.testCounts
    && value.device
    && value.cohorts
    && value.authorizationReferences
    && value.mutationCounts
    && value.finalDispatchCounts,
  );
  return {
    complete,
    evidence: complete
      ? 'immutable release identity and all required evidence counts recorded'
      : 'missing or incomplete final release evidence index',
  };
}

export function collectOfflineReleaseFacts(repoRoot) {
  const localRoot = join(repoRoot, 'local');
  const voiceRoot = join(localRoot, 'apps/voice');
  const readinessScript = read(
    join(localRoot, 'scripts/h092-h095-readiness-canary.sh'),
  );
  const readinessEvidence = read(
    join(voiceRoot, 'test-artifacts/h092-h095-readiness-2026-07-28.md'),
  );
  const h094 = json(
    join(voiceRoot, 'test-artifacts/h094-general-mobile-automated-evidence.json'),
  );
  const h095 = read(
    join(localRoot, 'docs/2026-07-28-h095-migration-flag-audit.md'),
  );
  const runtimePolicy = read(join(voiceRoot, 'lib/runtime-policy.ts'));
  const runtimePolicyTests = read(join(voiceRoot, 'lib/runtime-policy.test.ts'));
  const rolloutTests = read(
    join(voiceRoot, 'lib/realtime/rollout-controller.test.ts'),
  );
  const blinkitTests = read(join(voiceRoot, 'lib/blinkit-execution.test.ts'));
  const settingsTests = read(
    join(
      voiceRoot,
      'lib/general-mobile/v2/android-settings-read-only-adapter.test.ts',
    ),
  );
  const mutationTruthTests = read(
    join(
      voiceRoot,
      'lib/execution/v2/cart-mutation-execution-truth.test.ts',
    ),
  );
  const productionTelemetry = [
    productionSources(join(voiceRoot, 'lib/realtime')),
    read(join(voiceRoot, 'lib/stage-metrics.ts')),
  ].join('\n');
  const usageFields = [
    /input(?:_|)TextTokens/iu,
    /input(?:_|)ImageTokens/iu,
    /cached(?:_|)Tokens/iu,
    /output(?:_|)Tokens/iu,
  ];
  const rollbackRegressions = [
    rolloutTests.includes('falls back once on Realtime failure and timeout'),
    blinkitTests.includes('keeps final dispatch disabled by default'),
    blinkitTests.includes(
      'preserves ambiguity and reconciles read-only without retrying dispatch',
    ),
    settingsTests.includes(
      'records rollback evidence and disables the adapter immediately',
    ),
    mutationTruthTests.includes(
      'requires fresh read-only reconciliation before releasing a retry',
    ),
  ];
  const costBounds = [
    runtimePolicy.includes("'gpt-realtime-2.1'"),
    runtimePolicy.includes("'gpt-4.1-mini'"),
    runtimePolicy.includes("'semantic_only'"),
    runtimePolicy.includes('8_000'),
    runtimePolicy.includes('1_500_000'),
    runtimePolicyTests.includes('uses cost-bounded defaults'),
    runtimePolicyTests.includes('clamps numeric values'),
  ];
  const fallbackRegressions = [
    runtimePolicyTests.includes('preserves semantic fallback'),
    rolloutTests.includes('falls back once on Realtime failure and timeout'),
  ];
  return {
    finalEvidence: finalEvidence(
      join(voiceRoot, 'test-artifacts/h092-h095-final-evidence.json'),
    ),
    h092: {
      physicalCanary: /\*\*H092[^]*physical[^]*PASS(?:ED)?/iu.test(
        readinessEvidence,
      )
        ? 'passed'
        : 'not_passed',
      preflight: /RESULT h092_preflight=ALLOWED blocked=0/u.test(
        readinessEvidence,
      )
        ? 'allowed'
        : /RESULT h092_preflight=REFUSED/u.test(readinessEvidence)
          ? 'refused'
          : 'missing',
    },
    h093: h093Evidence(
      join(voiceRoot, 'test-artifacts/h093-cod-canary-evidence.json'),
    ),
    h094: {
      automated:
        h094?.automatedEvidence?.complete === true
        && h094?.automatedEvidence?.tests?.passed
          === h094?.automatedEvidence?.tests?.total
        && h094?.automatedEvidence?.typecheck?.status === 'passed',
      automatedEvidence: h094
        ? `complete=${String(h094.automatedEvidence?.complete ?? 'missing')}`
        : 'automated evidence artifact missing',
      physical: h094?.physicalEvidence?.complete === true
        && h094?.physicalEvidence?.status === 'passed',
      physicalEvidence: h094
        ? `status=${String(h094.physicalEvidence?.status ?? 'missing')}`
        : 'physical evidence artifact missing',
    },
    h095: {
      complete: /Result:\s+\*\*READY FOR H095 CLOSURE\*\*/u.test(h095),
      evidence: /Result:\s+\*\*NOT READY/u.test(h095)
        ? 'migration/convergence audit explicitly not ready'
        : h095
          ? 'migration/convergence audit is not a passing artifact'
          : 'migration/convergence audit missing',
    },
    modelPolicy: {
      aggregateUsageTelemetry: usageFields.every((pattern) =>
        pattern.test(productionTelemetry)),
      costBoundsAligned: costBounds.every(Boolean),
      costEvidence: costBounds.every(Boolean)
        ? 'runtime defaults, clamps, and tests match the policy bounds'
        : 'runtime model/cost policy and tests are not aligned',
      fallbackEvidence: fallbackRegressions.every(Boolean)
        ? 'semantic terminal fallback and one bounded Responses fallback are tested'
        : 'bounded fallback regression declarations are incomplete',
      fallbackRegressionsDeclared: fallbackRegressions.every(Boolean),
      usageEvidence: usageFields.every((pattern) =>
        pattern.test(productionTelemetry))
        ? 'aggregate text/image/cached/output usage fields are production-reachable'
        : 'aggregate text/image/cached/output usage telemetry is not production-reachable',
    },
    readinessProbeUnsafeOperations:
      unsafeReadinessOperations(readinessScript),
    rollback: {
      evidence: rollbackRegressions.every(Boolean)
        ? 'fallback, final-dispatch disable, adapter rollback, and reconciliation regressions declared'
        : 'one or more required rollback regression declarations are missing',
      regressionsDeclared: rollbackRegressions.every(Boolean),
    },
  };
}
