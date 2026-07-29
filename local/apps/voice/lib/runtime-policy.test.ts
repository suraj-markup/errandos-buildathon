import { describe, expect, it } from 'vitest';

import { loadVoiceRuntimePolicy } from './runtime-policy';

describe('loadVoiceRuntimePolicy', () => {
  it('uses cost-bounded defaults with a deterministic safe fallback', () => {
    const policy = loadVoiceRuntimePolicy({});

    expect(policy.boundedControlModel).toBe('gpt-4.1-mini');
    expect(policy.controlFallbackOrder).toEqual([
      'realtime_control',
      'responses_control',
      'semantic_only',
    ]);
    expect(policy.realtime).toMatchObject({
      contextTokenLimit: 8_000,
      maxSessionDurationMs: 900_000,
      model: 'gpt-realtime-2.1',
      reasoningEffort: 'low',
      reconnectAttempts: 2,
    });
    expect(policy.screenshot).toMatchObject({
      detail: 'low',
      maxCapturesPerTask: 4,
      maxImageBytes: 1_500_000,
      minCaptureIntervalMs: 5_000,
    });
  });

  it('loads supported overrides and preserves semantic fallback', () => {
    const policy = loadVoiceRuntimePolicy({
      JALDI_CONTROL_FALLBACK_ORDER:
        'responses_control,realtime_control,responses_control',
      JALDI_REALTIME_CONTEXT_TOKEN_LIMIT: '12000',
      JALDI_REALTIME_MAX_SESSION_MS: '600000',
      JALDI_REALTIME_REASONING_EFFORT: 'medium',
      JALDI_REALTIME_RECONNECT_ATTEMPTS: '1',
      JALDI_REALTIME_RECONNECT_BASE_DELAY_MS: '750',
      JALDI_REALTIME_RECONNECT_MAX_DELAY_MS: '3000',
      JALDI_SCREENSHOT_DETAIL: 'high',
      JALDI_SCREENSHOT_MAX_CAPTURES_PER_TASK: '7',
      OPENAI_BOUNDED_CONTROL_MODEL: 'gpt-4.1',
      OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1',
    });

    expect(policy.boundedControlModel).toBe('gpt-4.1');
    expect(policy.controlFallbackOrder).toEqual([
      'responses_control',
      'realtime_control',
      'semantic_only',
    ]);
    expect(policy.realtime.contextTokenLimit).toBe(12_000);
    expect(policy.realtime.maxSessionDurationMs).toBe(600_000);
    expect(policy.realtime.reasoningEffort).toBe('medium');
    expect(policy.realtime.reconnectAttempts).toBe(1);
    expect(policy.realtime.reconnectBaseDelayMs).toBe(750);
    expect(policy.realtime.reconnectMaxDelayMs).toBe(3_000);
    expect(policy.screenshot.detail).toBe('high');
    expect(policy.screenshot.maxCapturesPerTask).toBe(7);
  });

  it('clamps numeric values and rejects malformed model and enum values', () => {
    const policy = loadVoiceRuntimePolicy({
      JALDI_CONTROL_FALLBACK_ORDER: 'unknown',
      JALDI_REALTIME_CONTEXT_TOKEN_LIMIT: '999999',
      JALDI_REALTIME_MAX_SESSION_MS: '-1',
      JALDI_REALTIME_REASONING_EFFORT: 'max',
      JALDI_REALTIME_RECONNECT_ATTEMPTS: 'NaN',
      JALDI_REALTIME_RECONNECT_BASE_DELAY_MS: '9000',
      JALDI_REALTIME_RECONNECT_MAX_DELAY_MS: '200',
      JALDI_SCREENSHOT_DETAIL: 'original',
      JALDI_SCREENSHOT_MAX_CAPTURES_PER_TASK: '100',
      OPENAI_BOUNDED_CONTROL_MODEL: 'bad model name',
    });

    expect(policy.boundedControlModel).toBe('gpt-4.1-mini');
    expect(policy.controlFallbackOrder).toEqual([
      'realtime_control',
      'responses_control',
      'semantic_only',
    ]);
    expect(policy.realtime.contextTokenLimit).toBe(64_000);
    expect(policy.realtime.maxSessionDurationMs).toBe(60_000);
    expect(policy.realtime.reasoningEffort).toBe('low');
    expect(policy.realtime.reconnectAttempts).toBe(2);
    expect(policy.realtime.reconnectMaxDelayMs).toBe(9_000);
    expect(policy.screenshot.detail).toBe('low');
    expect(policy.screenshot.maxCapturesPerTask).toBe(20);
  });
});
