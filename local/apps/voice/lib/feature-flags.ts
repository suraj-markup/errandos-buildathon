export type VoiceFeatureFlags = {
  authoritativeTaskStateV1: boolean;
  phoneTaskV2: boolean;
  realtimeControlV1: boolean;
  realtimePhoneToolsV1: boolean;
  realtimeShadowV1: boolean;
  screenshotObservationV1: boolean;
  visionGroundingV1: boolean;
};

type VoiceFeatureFlagSnapshot = VoiceFeatureFlags & {
  /**
   * Compatibility-only telemetry field for the existing coordinator log.
   * OpenAI Realtime audio has no route or environment-controlled rollout flag.
   */
  readonly realtimeVoiceV1: false;
};

type Environment = Record<string, string | undefined>;

function enabled(environment: Environment, name: string): boolean {
  const value = environment[name]?.trim().toLocaleLowerCase('en-US');
  return value === '1' || value === 'true';
}

export function loadVoiceFeatureFlags(
  environment: Environment = process.env,
): VoiceFeatureFlagSnapshot {
  return {
    // Workflow V2 is a release invariant. Rollback is performed by deploying
    // the previous release, never by running two workflow engines behind a
    // mutable process environment flag.
    authoritativeTaskStateV1: true,
    phoneTaskV2: true,
    realtimeControlV1: enabled(
      environment,
      'JALDI_REALTIME_CONTROL_V1',
    ),
    realtimePhoneToolsV1: enabled(
      environment,
      'JALDI_REALTIME_PHONE_TOOLS_V1',
    ),
    realtimeShadowV1: enabled(
      environment,
      'JALDI_REALTIME_SHADOW_V1',
    ),
    realtimeVoiceV1: false,
    screenshotObservationV1: enabled(
      environment,
      'JALDI_SCREENSHOT_OBSERVATION_V1',
    ),
    visionGroundingV1: enabled(
      environment,
      'JALDI_VISION_GROUNDING_V1',
    ),
  };
}
