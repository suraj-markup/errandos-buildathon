import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  ExecutionLoopDetectorV2,
  executionStepFingerprintV2,
} from './loop-detector';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);

function observation(
  action: string,
  screen = action,
  taskRevision = 1,
) {
  return {
    taskId,
    taskRevision,
    screen: { page: screen },
    action: { capability: action },
    result: { status: 'unchanged' },
  };
}

describe('execution loop detector v2', () => {
  it('fingerprints screen, task revision, action, and result deterministically', () => {
    const left = executionStepFingerprintV2({
      ...observation('search'),
      result: { status: 'unchanged', count: 2 },
    });
    const right = executionStepFingerprintV2({
      ...observation('search'),
      result: { count: 2, status: 'unchanged' },
    });

    expect(left).toBe(right);
    expect(executionStepFingerprintV2(observation('cart'))).not.toBe(left);
    expect(executionStepFingerprintV2(observation('search', 'search', 2)))
      .not.toBe(left);
  });

  it('stops deterministic no-progress repetition at the configured bound', () => {
    const detector = new ExecutionLoopDetectorV2({
      maxNoProgressRepeats: 3,
    });

    expect(detector.observe(observation('search')).decision).toBe('continue');
    expect(detector.observe(observation('search')).decision).toBe('continue');
    expect(detector.observe(observation('search'))).toMatchObject({
      decision: 'stop',
      reason: 'repeated_no_progress',
      repetitions: 3,
      cycleLength: 1,
    });
  });

  it('stops a repeated search/cart/back cycle and resets after task progress', () => {
    const detector = new ExecutionLoopDetectorV2({
      maxCycleLength: 3,
      maxCycleRepeats: 2,
      maxNoProgressRepeats: 4,
    });
    const cycle = ['search', 'cart', 'back', 'search', 'cart'];
    cycle.forEach((action) => {
      expect(detector.observe(observation(action)).decision).toBe('continue');
    });
    expect(detector.observe(observation('back'))).toMatchObject({
      decision: 'stop',
      reason: 'repeated_cycle',
      repetitions: 2,
      cycleLength: 3,
    });

    expect(detector.observe(observation('search', 'search', 2)).decision)
      .toBe('continue');
  });
});
