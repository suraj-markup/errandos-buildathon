type ScreenshotDetail = 'auto' | 'high' | 'low';

type ControlProvider =
  | 'realtime_control'
  | 'responses_control'
  | 'semantic_only';

type VoiceRuntimePolicy = {
  boundedControlModel: string;
  controlFallbackOrder: readonly ControlProvider[];
  realtime: {
    contextTokenLimit: number;
    maxSessionDurationMs: number;
    model: string;
    reasoningEffort: 'low' | 'medium';
    reconnectAttempts: number;
    reconnectBaseDelayMs: number;
    reconnectMaxDelayMs: number;
  };
  screenshot: {
    detail: ScreenshotDetail;
    groundingTimeoutMs: number;
    maxCapturesPerTask: number;
    maxImageBytes: number;
    minCaptureIntervalMs: number;
    taskRetentionMs: number;
  };
};

type Environment = Record<string, string | undefined>;

const DEFAULT_FALLBACK_ORDER: readonly ControlProvider[] = Object.freeze([
  'realtime_control',
  'responses_control',
  'semantic_only',
]);

const allowedProviders = new Set<ControlProvider>(DEFAULT_FALLBACK_ORDER);

function integer(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function model(
  environment: Environment,
  name: string,
  fallback: string,
): string {
  const value = environment[name]?.trim();
  if (!value || !/^[a-z0-9][a-z0-9._:-]{1,127}$/i.test(value)) {
    return fallback;
  }
  return value;
}

function oneOf<T extends string>(
  environment: Environment,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = environment[name]?.trim().toLocaleLowerCase('en-US') as T;
  return allowed.includes(value) ? value : fallback;
}

function fallbackOrder(environment: Environment): readonly ControlProvider[] {
  const configured = environment.JALDI_CONTROL_FALLBACK_ORDER;
  if (!configured?.trim()) return DEFAULT_FALLBACK_ORDER;

  const result: ControlProvider[] = [];
  for (const rawValue of configured.split(',')) {
    const value = rawValue.trim() as ControlProvider;
    if (!allowedProviders.has(value) || result.includes(value)) continue;
    result.push(value);
  }

  // A remote outage must always end in a bounded local semantic outcome.
  if (!result.includes('semantic_only')) result.push('semantic_only');
  return result.length > 1
    ? Object.freeze(result)
    : DEFAULT_FALLBACK_ORDER;
}

export function loadVoiceRuntimePolicy(
  environment: Environment = process.env,
): VoiceRuntimePolicy {
  const reconnectBaseDelayMs = integer(
    environment,
    'JALDI_REALTIME_RECONNECT_BASE_DELAY_MS',
    500,
    100,
    10_000,
  );
  const reconnectMaxDelayMs = Math.max(
    reconnectBaseDelayMs,
    integer(
      environment,
      'JALDI_REALTIME_RECONNECT_MAX_DELAY_MS',
      2_000,
      100,
      30_000,
    ),
  );

  return Object.freeze({
    boundedControlModel: model(
      environment,
      'OPENAI_BOUNDED_CONTROL_MODEL',
      'gpt-4.1-mini',
    ),
    controlFallbackOrder: fallbackOrder(environment),
    realtime: Object.freeze({
      contextTokenLimit: integer(
        environment,
        'JALDI_REALTIME_CONTEXT_TOKEN_LIMIT',
        8_000,
        1_000,
        64_000,
      ),
      maxSessionDurationMs: integer(
        environment,
        'JALDI_REALTIME_MAX_SESSION_MS',
        15 * 60_000,
        60_000,
        55 * 60_000,
      ),
      model: model(
        environment,
        'OPENAI_REALTIME_MODEL',
        'gpt-realtime-2.1',
      ),
      reasoningEffort: oneOf(
        environment,
        'JALDI_REALTIME_REASONING_EFFORT',
        ['low', 'medium'] as const,
        'low',
      ),
      reconnectAttempts: integer(
        environment,
        'JALDI_REALTIME_RECONNECT_ATTEMPTS',
        2,
        0,
        5,
      ),
      reconnectBaseDelayMs,
      reconnectMaxDelayMs,
    }),
    screenshot: Object.freeze({
      detail: oneOf(
        environment,
        'JALDI_SCREENSHOT_DETAIL',
        ['auto', 'high', 'low'] as const,
        'low',
      ),
      groundingTimeoutMs: integer(
        environment,
        'JALDI_SCREENSHOT_GROUNDING_TIMEOUT_MS',
        3_500,
        250,
        15_000,
      ),
      maxCapturesPerTask: integer(
        environment,
        'JALDI_SCREENSHOT_MAX_CAPTURES_PER_TASK',
        4,
        1,
        20,
      ),
      maxImageBytes: integer(
        environment,
        'JALDI_SCREENSHOT_MAX_IMAGE_BYTES',
        1_500_000,
        32_000,
        5_000_000,
      ),
      minCaptureIntervalMs: integer(
        environment,
        'JALDI_SCREENSHOT_MIN_CAPTURE_INTERVAL_MS',
        5_000,
        0,
        60_000,
      ),
      taskRetentionMs: integer(
        environment,
        'JALDI_SCREENSHOT_TASK_RETENTION_MS',
        15 * 60_000,
        60_000,
        60 * 60_000,
      ),
    }),
  });
}

export const voiceRuntimePolicy = loadVoiceRuntimePolicy();
