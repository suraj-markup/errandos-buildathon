const deadlineStages = [
  'appium_session',
  'control_model',
  'device_automation',
  'grounding',
  'phone_queue_wait',
  'provider_search',
  'sarvam_stt',
  'sarvam_tts',
  'screenshot_capture',
] as const;

export type DeadlineStage = (typeof deadlineStages)[number];

type DeadlineRecoveryAction =
  | 'reconcile_only'
  | 'retry_safe'
  | 'semantic_fallback'
  | 'stop';

type StageTimeoutOutcome = {
  ok: false;
  recoveryAction: DeadlineRecoveryAction;
  stage: DeadlineStage;
  status: 'stage_timeout';
  timeoutMs: number;
};

const defaultDeadlines: Readonly<Record<DeadlineStage, number>> = {
  appium_session: 20_000,
  control_model: 15_000,
  device_automation: 45_000,
  grounding: 4_000,
  phone_queue_wait: 15_000,
  provider_search: 30_000,
  sarvam_stt: 20_000,
  sarvam_tts: 15_000,
  screenshot_capture: 8_000,
};

const recoveryByStage: Readonly<
  Record<DeadlineStage, DeadlineRecoveryAction>
> = {
  appium_session: 'retry_safe',
  control_model: 'retry_safe',
  device_automation: 'stop',
  grounding: 'semantic_fallback',
  phone_queue_wait: 'retry_safe',
  provider_search: 'retry_safe',
  sarvam_stt: 'retry_safe',
  sarvam_tts: 'retry_safe',
  screenshot_capture: 'semantic_fallback',
};

export class StageDeadlineExceededError extends Error {
  public readonly code = 'stage_timeout';

  public constructor(
    readonly stage: DeadlineStage,
    readonly timeoutMs: number,
    readonly recoveryAction: DeadlineRecoveryAction =
      recoveryByStage[stage],
  ) {
    super(`${stage} exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'StageDeadlineExceededError';
  }

  public outcome(): StageTimeoutOutcome {
    return {
      ok: false,
      recoveryAction: this.recoveryAction,
      stage: this.stage,
      status: 'stage_timeout',
      timeoutMs: this.timeoutMs,
    };
  }
}

export class StageDeadlinePolicy {
  readonly #deadlines: Readonly<Record<DeadlineStage, number>>;

  public constructor(
    overrides: Partial<Record<DeadlineStage, number>> = {},
  ) {
    const deadlines = { ...defaultDeadlines, ...overrides };
    deadlineStages.forEach((stage) => {
      const value = deadlines[stage];
      if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
        throw new Error(`${stage} deadline must be between 1 and 300000ms.`);
      }
    });
    this.#deadlines = Object.freeze(deadlines);
  }

  public timeoutFor(stage: DeadlineStage): number {
    return this.#deadlines[stage];
  }

  public timeout(
    stage: DeadlineStage,
    recoveryAction?: DeadlineRecoveryAction,
  ): StageDeadlineExceededError {
    return new StageDeadlineExceededError(
      stage,
      this.timeoutFor(stage),
      recoveryAction ?? recoveryByStage[stage],
    );
  }
}

type RunWithStageDeadlineInput<T> = {
  recoveryAction?: DeadlineRecoveryAction;
  run: (signal: AbortSignal) => Promise<T>;
  stage: DeadlineStage;
  timeoutMs: number;
};

export async function runWithStageDeadline<T>(
  input: RunWithStageDeadlineInput<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StageDeadlineExceededError(
        input.stage,
        input.timeoutMs,
        input.recoveryAction ?? recoveryByStage[input.stage],
      ));
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => input.run(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function stageTimeoutOutcome(
  error: unknown,
): StageTimeoutOutcome | undefined {
  return error instanceof StageDeadlineExceededError
    ? error.outcome()
    : undefined;
}

export const stageDeadlinePolicy = new StageDeadlinePolicy();
