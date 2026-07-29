import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loadVoiceFeatureFlags,
  type VoiceFeatureFlags,
} from './feature-flags';

type MigrationFlagAudit = {
  environment: string;
  evidence: Array<{
    file: string;
    token: string;
  }>;
  property: keyof VoiceFeatureFlags;
};

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const migrationFlags: MigrationFlagAudit[] = [];

describe('H095 migration flag audit', () => {
  it.each(migrationFlags)(
    'keeps $environment while its production boundary exists',
    ({ environment, evidence, property }) => {
      expect(loadVoiceFeatureFlags({ [environment]: 'true' })[property])
        .toBe(true);
      for (const boundary of evidence) {
        expect(source(boundary.file)).toContain(boundary.token);
      }
    },
  );

  it('classifies every configurable voice flag as migration or operational', () => {
    const migration = migrationFlags.map(({ property }) => property);
    const operational: Array<keyof VoiceFeatureFlags> = [
      'realtimeControlV1',
      'realtimePhoneToolsV1',
      'realtimeShadowV1',
      'screenshotObservationV1',
      'visionGroundingV1',
    ];
    const configured = Object.keys(loadVoiceFeatureFlags({}))
      .filter((property) =>
        ![
          'authoritativeTaskStateV1',
          'phoneTaskV2',
          'realtimeVoiceV1',
        ].includes(property))
      .sort();

    expect(configured).toEqual([...migration, ...operational].sort());
  });

  it('classifies Workflow V2 engine state as release invariants', () => {
    const flags = loadVoiceFeatureFlags({});
    expect(flags.authoritativeTaskStateV1).toBe(true);
    expect(flags.phoneTaskV2).toBe(true);
  });

  it('records the completed V1/V2 source convergence cutover', () => {
    const coordinator = source('./voice-turn/coordinator.ts');

    expect(coordinator).toContain('phoneTaskRepositoryV2()');
    expect(coordinator).not.toContain('authoritativeTaskRepository()');
    expect(coordinator).not.toContain('synchronizeLocalTaskProjectionV2(');
    expect(coordinator).not.toContain('featureFlags.phoneTaskV2');
    expect(coordinator).not.toContain('featureFlags.authoritativeTaskStateV1');
    expect(coordinator).toContain('prepareVoiceTurnCodCheckoutV2(');
    expect(coordinator).toContain('confirmVoiceTurnCodCheckoutV2(');
  });

  it('keeps retired engine-selection tokens out of production', () => {
    const coordinator = source('./voice-turn/coordinator.ts');
    const runtimeRecovery = source('./workflow/v2/runtime-recovery.ts');
    const blockers = [
      'featureFlags.authoritativeTaskStateV1',
      'featureFlags.phoneTaskV2',
      'authoritativeTaskRepository()',
      'synchronizeLocalTaskProjectionV2(',
      'protocolVersion: featureFlags.phoneTaskV2 ? 2 : 1',
      'if (!featureFlags.phoneTaskV2) return phoneResult;',
    ];

    for (const blocker of blockers) expect(coordinator).not.toContain(blocker);
    expect(runtimeRecovery).not.toContain('flags.phoneTaskV2');
  });

  it('keeps retired settings out of production configuration', () => {
    const featureFlagSource = source('./feature-flags.ts');
    const exampleEnvironment = source('../.env.example');
    const retired = [
      'JALDI_OPERATION_LIFECYCLE_V1',
      'JALDI_ATOMIC_PRODUCT_SELECTION_V1',
      'JALDI_PRECISE_ATTENTION_V1',
      'JALDI_REALTIME_VOICE_V1',
      'JALDI_STRUCTURED_PROGRESS_V1',
      'JALDI_TASK_RECOVERY_V1',
    ];

    for (const environment of retired) {
      expect(featureFlagSource).not.toContain(environment);
      expect(exampleEnvironment).not.toContain(environment);
    }
    expect(existsSync(new URL(
      '../app/api/realtime/session/route.ts',
      import.meta.url,
    ))).toBe(false);
  });
});
