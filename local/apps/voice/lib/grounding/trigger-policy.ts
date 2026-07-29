export type ScreenshotTrigger =
  | 'ambiguity'
  | 'clarification'
  | 'decision'
  | 'explicit_attention'
  | 'verification_failure';

type ScreenshotBudgetConfig = {
  groundingTimeoutMs?: number;
  maxCapturesPerTask?: number;
  maxImageBytes?: number;
  minCaptureIntervalMs?: number;
  taskRetentionMs?: number;
};

type ScreenshotCapturePermit =
  | {
      allowed: true;
      groundingTimeoutMs: number;
      maxImageBytes: number;
      sequence: number;
    }
  | {
      allowed: false;
      reason:
        | 'capture_budget_exhausted'
        | 'capture_rate_limited'
        | 'trigger_not_allowed';
    };

type TaskBudget = {
  attempts: number;
  lastAttemptAt: number;
  touchedAt: number;
};

const allowedTriggers = new Set<ScreenshotTrigger>([
  'ambiguity',
  'clarification',
  'decision',
  'explicit_attention',
  'verification_failure',
]);

export class ScreenshotTriggerPolicy {
  readonly #groundingTimeoutMs: number;
  readonly #maxCapturesPerTask: number;
  readonly #maxImageBytes: number;
  readonly #minCaptureIntervalMs: number;
  readonly #now: () => number;
  readonly #taskRetentionMs: number;
  readonly #tasks = new Map<string, TaskBudget>();

  public constructor(
    config: ScreenshotBudgetConfig = {},
    now: () => number = Date.now,
  ) {
    this.#groundingTimeoutMs = boundedInteger(
      config.groundingTimeoutMs,
      voiceRuntimePolicy.screenshot.groundingTimeoutMs,
      250,
      15_000,
    );
    this.#maxCapturesPerTask = boundedInteger(
      config.maxCapturesPerTask,
      voiceRuntimePolicy.screenshot.maxCapturesPerTask,
      1,
      20,
    );
    this.#maxImageBytes = boundedInteger(
      config.maxImageBytes,
      voiceRuntimePolicy.screenshot.maxImageBytes,
      32_000,
      5_000_000,
    );
    this.#minCaptureIntervalMs = boundedInteger(
      config.minCaptureIntervalMs,
      voiceRuntimePolicy.screenshot.minCaptureIntervalMs,
      0,
      60_000,
    );
    this.#taskRetentionMs = boundedInteger(
      config.taskRetentionMs,
      voiceRuntimePolicy.screenshot.taskRetentionMs,
      60_000,
      60 * 60_000,
    );
    this.#now = now;
  }

  public authorize(input: {
    taskId: string;
    trigger: ScreenshotTrigger | string;
  }): ScreenshotCapturePermit {
    this.cleanup();
    if (!allowedTriggers.has(input.trigger as ScreenshotTrigger)) {
      return { allowed: false, reason: 'trigger_not_allowed' };
    }
    const now = this.#now();
    const current = this.#tasks.get(input.taskId);
    if (current && current.attempts >= this.#maxCapturesPerTask) {
      return { allowed: false, reason: 'capture_budget_exhausted' };
    }
    if (
      current
      && now - current.lastAttemptAt < this.#minCaptureIntervalMs
    ) {
      return { allowed: false, reason: 'capture_rate_limited' };
    }
    const attempts = (current?.attempts ?? 0) + 1;
    this.#tasks.set(input.taskId, {
      attempts,
      lastAttemptAt: now,
      touchedAt: now,
    });
    return {
      allowed: true,
      groundingTimeoutMs: this.#groundingTimeoutMs,
      maxImageBytes: this.#maxImageBytes,
      sequence: attempts,
    };
  }

  public reset(taskId: string): void {
    this.#tasks.delete(taskId);
  }

  public cleanup(): number {
    const threshold = this.#now() - this.#taskRetentionMs;
    let removed = 0;
    for (const [taskId, budget] of this.#tasks) {
      if (budget.touchedAt <= threshold) {
        this.#tasks.delete(taskId);
        removed += 1;
      }
    }
    return removed;
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate)) return fallback;
  return Math.min(Math.max(candidate, minimum), maximum);
}
import { voiceRuntimePolicy } from '../runtime-policy';
