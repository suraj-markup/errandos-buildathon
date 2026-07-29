import { describe, expect, it } from 'vitest';
import { loadVoiceFeatureFlags } from './feature-flags';

describe('voice feature flags', () => {
  it('keeps V2 release invariants on while optional subsystems default off', () => {
    expect(loadVoiceFeatureFlags({})).toEqual({
      authoritativeTaskStateV1: true,
      phoneTaskV2: true,
      realtimeControlV1: false,
      realtimePhoneToolsV1: false,
      realtimeShadowV1: false,
      realtimeVoiceV1: false,
      screenshotObservationV1: false,
      visionGroundingV1: false,
    });
  });

  it('accepts only explicit true or 1 values', () => {
    expect(loadVoiceFeatureFlags({
      JALDI_REALTIME_CONTROL_V1: 'true',
      JALDI_VISION_GROUNDING_V1: 'invalid',
    })).toMatchObject({
      authoritativeTaskStateV1: true,
      phoneTaskV2: true,
      realtimeControlV1: true,
      realtimeVoiceV1: false,
      visionGroundingV1: false,
    });
  });

  it('ignores retired flags that had no production boundary', () => {
    const flags = loadVoiceFeatureFlags({
      JALDI_OPERATION_LIFECYCLE_V1: 'true',
      JALDI_PRECISE_ATTENTION_V1: 'true',
      JALDI_REALTIME_VOICE_V1: 'true',
    });

    expect(flags).not.toHaveProperty('operationLifecycleV1');
    expect(flags).not.toHaveProperty('preciseAttentionV1');
    expect(flags.realtimeVoiceV1).toBe(false);
  });
});
