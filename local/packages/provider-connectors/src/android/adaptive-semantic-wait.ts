export interface SemanticWaitAttempt {
  /** One-based polling-cycle number. */
  attempt: number;
  /** Time since this wait began, sampled immediately after snapshot acquisition. */
  elapsedMs: number;
}

export type SemanticCondition<Value, Reason extends string> =
  | { satisfied: true; value: Value }
  | { satisfied: false; reason: Reason };

export interface AdaptiveSemanticWaitOptions<
  Snapshot,
  Value,
  Phase extends string,
  Reason extends string,
> {
  phase: Phase;
  /** Overall polling deadline expressed as elapsed milliseconds. */
  deadlineMs: number;
  acquireSnapshot: () => Promise<Snapshot>;
  evaluate: (
    snapshot: Snapshot,
    attempt: SemanticWaitAttempt,
  ) => SemanticCondition<Value, Reason> | Promise<SemanticCondition<Value, Reason>>;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  maxAttempts?: number;
  backoffFactor?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface SemanticWaitResult<Value> {
  value: Value;
  attempts: number;
  elapsedMs: number;
}

export class SemanticConditionTimeoutError<
  Phase extends string = string,
  Reason extends string = string,
> extends Error {
  public override readonly name = 'SemanticConditionTimeoutError';

  public constructor(
    public readonly phase: Phase,
    public readonly reason: Reason,
    public readonly attempts: number,
    public readonly elapsedMs: number,
    public readonly deadlineMs: number,
  ) {
    super(
      `Android semantic condition timed out`
      + ` (phase=${phase}, reason=${reason}, attempts=${attempts},`
      + ` elapsedMs=${elapsedMs}, deadlineMs=${deadlineMs})`,
    );
  }
}

/**
 * Poll a semantic condition against exactly one newly acquired hierarchy
 * snapshot per cycle. The first cycle runs immediately; subsequent intervals
 * back off and are clipped to the remaining phase deadline.
 */
export async function waitForSemanticCondition<
  Snapshot,
  Value,
  Phase extends string,
  Reason extends string,
>(
  options: AdaptiveSemanticWaitOptions<Snapshot, Value, Phase, Reason>,
): Promise<SemanticWaitResult<Value>> {
  const initialIntervalMs = options.initialIntervalMs ?? 100;
  const maxIntervalMs = options.maxIntervalMs ?? 1_000;
  const backoffFactor = options.backoffFactor ?? 1.5;
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  validateOptions(
    options.deadlineMs,
    initialIntervalMs,
    maxIntervalMs,
    backoffFactor,
    maxAttempts,
  );

  const now = options.now ?? Date.now;
  const wait = options.wait
    ?? ((milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let intervalMs = initialIntervalMs;
  let attempts = 0;
  let lastReason: Reason | undefined;

  while (true) {
    attempts += 1;
    const snapshot = await options.acquireSnapshot();
    const acquiredElapsedMs = elapsedSince(now, startedAt);
    const condition = await options.evaluate(snapshot, {
      attempt: attempts,
      elapsedMs: acquiredElapsedMs,
    });
    const elapsedMs = elapsedSince(now, startedAt);
    if (condition.satisfied) {
      return { value: condition.value, attempts, elapsedMs };
    }
    lastReason = condition.reason;

    if (elapsedMs >= options.deadlineMs || attempts >= maxAttempts) {
      throw new SemanticConditionTimeoutError(
        options.phase,
        lastReason,
        attempts,
        elapsedMs,
        options.deadlineMs,
      );
    }

    const remainingMs = options.deadlineMs - elapsedMs;
    await wait(Math.min(intervalMs, remainingMs));
    const afterWaitElapsedMs = elapsedSince(now, startedAt);
    if (afterWaitElapsedMs >= options.deadlineMs) {
      throw new SemanticConditionTimeoutError(
        options.phase,
        lastReason,
        attempts,
        afterWaitElapsedMs,
        options.deadlineMs,
      );
    }
    intervalMs = Math.min(maxIntervalMs, intervalMs * backoffFactor);
  }
}

function elapsedSince(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

function validateOptions(
  deadlineMs: number,
  initialIntervalMs: number,
  maxIntervalMs: number,
  backoffFactor: number,
  maxAttempts: number,
): void {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError('deadlineMs must be a finite number greater than 0');
  }
  if (!Number.isFinite(initialIntervalMs) || initialIntervalMs <= 0) {
    throw new RangeError('initialIntervalMs must be a finite number greater than 0');
  }
  if (!Number.isFinite(maxIntervalMs) || maxIntervalMs < initialIntervalMs) {
    throw new RangeError('maxIntervalMs must be a finite number at least initialIntervalMs');
  }
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
    throw new RangeError('backoffFactor must be a finite number at least 1');
  }
  if (
    maxAttempts !== Number.POSITIVE_INFINITY
    && (!Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    throw new RangeError('maxAttempts must be a positive integer when provided');
  }
}
