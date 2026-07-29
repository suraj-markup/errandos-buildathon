import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StageDeadlineExceededError,
  StageDeadlinePolicy,
  runWithStageDeadline,
  stageTimeoutOutcome,
} from './stage-deadlines';

describe('independent stage deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts one overdue stage with a typed recovery outcome', async () => {
    vi.useFakeTimers();
    const work = runWithStageDeadline({
      run: async (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
      stage: 'sarvam_stt',
      timeoutMs: 50,
    });
    const rejection = expect(work).rejects.toBeInstanceOf(
      StageDeadlineExceededError,
    );
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    await work.catch((error) => {
      expect(stageTimeoutOutcome(error)).toEqual({
        ok: false,
        recoveryAction: 'retry_safe',
        stage: 'sarvam_stt',
        status: 'stage_timeout',
        timeoutMs: 50,
      });
    });
  });

  it('does not let another stage deadline affect completed work', async () => {
    vi.useFakeTimers();
    const work = runWithStageDeadline({
      run: async () => 'complete',
      stage: 'sarvam_tts',
      timeoutMs: 25,
    });
    await expect(work).resolves.toBe('complete');
    await vi.advanceTimersByTimeAsync(100);
  });

  it('validates and resolves independent policy values', () => {
    const policy = new StageDeadlinePolicy({
      control_model: 101,
      grounding: 202,
      phone_queue_wait: 303,
    });
    expect(policy.timeoutFor('control_model')).toBe(101);
    expect(policy.timeoutFor('grounding')).toBe(202);
    expect(policy.timeoutFor('phone_queue_wait')).toBe(303);
    expect(() => new StageDeadlinePolicy({ sarvam_tts: 0 }))
      .toThrow('sarvam_tts deadline');
  });
});
