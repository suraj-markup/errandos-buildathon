import { describe, expect, it } from 'vitest';
import { ScreenshotTriggerPolicy } from './trigger-policy';

describe('screenshot trigger policy', () => {
  it.each([
    'clarification',
    'decision',
    'ambiguity',
    'verification_failure',
    'explicit_attention',
  ] as const)('allows the deliberate %s capture point', (trigger) => {
    const policy = new ScreenshotTriggerPolicy({
      minCaptureIntervalMs: 0,
    }, () => 1_000);

    expect(policy.authorize({ taskId: `task-${trigger}`, trigger })).toEqual({
      allowed: true,
      groundingTimeoutMs: 3_500,
      maxImageBytes: 1_500_000,
      sequence: 1,
    });
  });

  it('rejects generic continuous capture triggers', () => {
    const policy = new ScreenshotTriggerPolicy({}, () => 1_000);
    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'timer_tick',
    })).toEqual({
      allowed: false,
      reason: 'trigger_not_allowed',
    });
  });

  it('enforces frequency and per-task count independently', () => {
    let now = 1_000;
    const policy = new ScreenshotTriggerPolicy({
      maxCapturesPerTask: 2,
      minCaptureIntervalMs: 100,
    }, () => now);

    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'ambiguity',
    }).allowed).toBe(true);
    now = 1_050;
    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'ambiguity',
    })).toEqual({
      allowed: false,
      reason: 'capture_rate_limited',
    });
    now = 1_100;
    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'verification_failure',
    }).allowed).toBe(true);
    now = 1_200;
    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'explicit_attention',
    })).toEqual({
      allowed: false,
      reason: 'capture_budget_exhausted',
    });
    expect(policy.authorize({
      taskId: 'task-b',
      trigger: 'explicit_attention',
    }).allowed).toBe(true);
  });

  it('cleans expired task budgets and supports explicit reset', () => {
    let now = 1_000;
    const policy = new ScreenshotTriggerPolicy({
      maxCapturesPerTask: 1,
      minCaptureIntervalMs: 0,
      taskRetentionMs: 60_000,
    }, () => now);
    policy.authorize({ taskId: 'task-a', trigger: 'decision' });
    policy.reset('task-a');
    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'decision',
    }).allowed).toBe(true);

    now = 61_001;
    expect(policy.cleanup()).toBe(1);
    expect(policy.authorize({
      taskId: 'task-a',
      trigger: 'decision',
    }).allowed).toBe(true);
  });
});
