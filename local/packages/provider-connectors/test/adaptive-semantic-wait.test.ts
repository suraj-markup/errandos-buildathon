import { describe, expect, it } from 'vitest';
import {
  SemanticConditionTimeoutError,
  waitForSemanticCondition,
} from '../src/android/adaptive-semantic-wait.js';

describe('adaptive semantic condition wait', () => {
  it('checks immediately and returns the first semantic match without waiting', async () => {
    let snapshots = 0;
    const waits: number[] = [];

    const result = await waitForSemanticCondition({
      phase: 'search_entry',
      deadlineMs: 5_000,
      acquireSnapshot: async () => {
        snapshots += 1;
        return '<hierarchy><node text="Recent searches"/></hierarchy>';
      },
      evaluate: (source, context) => ({
        satisfied: true,
        value: { source, context },
      }),
      now: () => 100,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });

    expect(snapshots).toBe(1);
    expect(waits).toEqual([]);
    expect(result).toEqual({
      value: {
        source: '<hierarchy><node text="Recent searches"/></hierarchy>',
        context: { attempt: 1, elapsedMs: 0 },
      },
      attempts: 1,
      elapsedMs: 0,
    });
  });

  it('acquires exactly one snapshot per cycle and applies capped adaptive backoff', async () => {
    let time = 1_000;
    let snapshots = 0;
    const waits: number[] = [];

    const result = await waitForSemanticCondition({
      phase: 'add_control_discovery',
      deadlineMs: 5_000,
      initialIntervalMs: 100,
      maxIntervalMs: 250,
      backoffFactor: 2,
      acquireSnapshot: async () => {
        snapshots += 1;
        return `snapshot-${snapshots}`;
      },
      evaluate: (snapshot, { attempt }) => attempt === 4
        ? { satisfied: true, value: snapshot }
        : { satisfied: false, reason: 'add_control_absent' },
      now: () => time,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        time += milliseconds;
      },
    });

    expect(result).toEqual({ value: 'snapshot-4', attempts: 4, elapsedMs: 550 });
    expect(snapshots).toBe(4);
    expect(waits).toEqual([100, 200, 250]);
  });

  it('clips the last interval and throws a typed timeout with the latest precise reason', async () => {
    let time = 0;
    let snapshots = 0;
    const waits: number[] = [];
    let failure: unknown;

    try {
      await waitForSemanticCondition({
        phase: 'local_quantity_verification',
        deadlineMs: 450,
        initialIntervalMs: 200,
        maxIntervalMs: 500,
        backoffFactor: 2,
        acquireSnapshot: async () => {
          snapshots += 1;
          return snapshots;
        },
        evaluate: (snapshot) => ({
          satisfied: false,
          reason: snapshot === 1 ? 'quantity_control_absent' : 'quantity_stale',
        } as const),
        now: () => time,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
          time += milliseconds;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SemanticConditionTimeoutError);
    expect(failure).toMatchObject({
      name: 'SemanticConditionTimeoutError',
      phase: 'local_quantity_verification',
      reason: 'quantity_stale',
      attempts: 2,
      elapsedMs: 450,
      deadlineMs: 450,
    });
    expect(String(failure)).toContain(
      'phase=local_quantity_verification, reason=quantity_stale, attempts=2, elapsedMs=450',
    );
    expect(snapshots).toBe(2);
    expect(waits).toEqual([200, 250]);
  });

  it('rejects invalid timing configuration before acquiring a snapshot', async () => {
    let snapshots = 0;

    await expect(waitForSemanticCondition({
      phase: 'screen_recognition',
      deadlineMs: 1_000,
      initialIntervalMs: 300,
      maxIntervalMs: 200,
      acquireSnapshot: async () => {
        snapshots += 1;
        return '';
      },
      evaluate: () => ({ satisfied: false, reason: 'unknown_screen' }),
    })).rejects.toThrow('maxIntervalMs must be a finite number at least initialIntervalMs');
    expect(snapshots).toBe(0);
  });
});
