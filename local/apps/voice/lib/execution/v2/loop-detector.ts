import type { LocalIdentifier } from '../../workflow/identifiers';
import { stableExecutionFingerprintV2 } from './fingerprint';

export type ExecutionLoopObservationV2 = {
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  screen: unknown;
  action: unknown;
  result: unknown;
};

export type ExecutionLoopDecisionV2 =
  | {
      decision: 'continue';
      fingerprint: string;
    }
  | {
      decision: 'stop';
      fingerprint: string;
      reason: 'repeated_cycle' | 'repeated_no_progress';
      repetitions: number;
      cycleLength: number;
    };

type LoopDetectorOptionsV2 = {
  maxCycleLength?: number;
  maxCycleRepeats?: number;
  maxHistory?: number;
  maxNoProgressRepeats?: number;
};

type FingerprintedObservation = {
  fingerprint: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function suffixRepeats(
  history: readonly FingerprintedObservation[],
  cycleLength: number,
  repetitions: number,
): boolean {
  const required = cycleLength * repetitions;
  if (history.length < required) return false;
  const start = history.length - required;
  for (let index = start + cycleLength; index < history.length; index += 1) {
    if (
      history[index]!.fingerprint
      !== history[start + ((index - start) % cycleLength)]!.fingerprint
    ) {
      return false;
    }
  }
  return true;
}

export function executionStepFingerprintV2(
  observation: ExecutionLoopObservationV2,
): string {
  if (
    !Number.isSafeInteger(observation.taskRevision)
    || observation.taskRevision < 0
  ) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  return stableExecutionFingerprintV2({
    taskId: observation.taskId,
    taskRevision: observation.taskRevision,
    screen: observation.screen,
    action: observation.action,
    result: observation.result,
  });
}

export class ExecutionLoopDetectorV2 {
  private readonly history: FingerprintedObservation[] = [];
  private readonly maxCycleLength: number;
  private readonly maxCycleRepeats: number;
  private readonly maxHistory: number;
  private readonly maxNoProgressRepeats: number;

  constructor(options: LoopDetectorOptionsV2 = {}) {
    this.maxCycleLength = positiveInteger(
      options.maxCycleLength ?? 4,
      'maxCycleLength',
    );
    this.maxCycleRepeats = positiveInteger(
      options.maxCycleRepeats ?? 2,
      'maxCycleRepeats',
    );
    this.maxHistory = positiveInteger(options.maxHistory ?? 32, 'maxHistory');
    this.maxNoProgressRepeats = positiveInteger(
      options.maxNoProgressRepeats ?? 3,
      'maxNoProgressRepeats',
    );
  }

  observe(
    observation: ExecutionLoopObservationV2,
  ): ExecutionLoopDecisionV2 {
    const last = this.history.at(-1);
    if (
      last
      && (
        last.taskId !== observation.taskId
        || last.taskRevision !== observation.taskRevision
      )
    ) {
      this.history.length = 0;
    }
    const fingerprint = executionStepFingerprintV2(observation);
    this.history.push({
      fingerprint,
      taskId: observation.taskId,
      taskRevision: observation.taskRevision,
    });
    while (this.history.length > this.maxHistory) this.history.shift();

    let identicalSuffix = 1;
    for (
      let index = this.history.length - 2;
      index >= 0 && this.history[index]!.fingerprint === fingerprint;
      index -= 1
    ) {
      identicalSuffix += 1;
    }
    if (identicalSuffix >= this.maxNoProgressRepeats) {
      return {
        decision: 'stop',
        fingerprint,
        reason: 'repeated_no_progress',
        repetitions: identicalSuffix,
        cycleLength: 1,
      };
    }

    const maximumCycle = Math.min(
      this.maxCycleLength,
      Math.floor(this.history.length / this.maxCycleRepeats),
    );
    for (let cycleLength = 2; cycleLength <= maximumCycle; cycleLength += 1) {
      if (suffixRepeats(this.history, cycleLength, this.maxCycleRepeats)) {
        return {
          decision: 'stop',
          fingerprint,
          reason: 'repeated_cycle',
          repetitions: this.maxCycleRepeats,
          cycleLength,
        };
      }
    }
    return { decision: 'continue', fingerprint };
  }

  reset(): void {
    this.history.length = 0;
  }
}
