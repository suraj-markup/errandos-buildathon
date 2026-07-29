import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PhoneOperationCancelledError,
  PhoneOperationQueueTimeoutError,
  cancelCurrentPhoneTask,
  enqueuePhoneOperation,
  enqueueRegisteredPhoneOperation,
  type PhoneOperationExecutionControl,
} from './operation-queue';
import { LocalOperationRegistry } from './operations/registry';
import { DeterministicStageMetricsCollector } from './stage-metrics';
import {
  StageDeadlineExceededError,
  stageTimeoutOutcome,
} from './stage-deadlines';

const taskId = 'task_12345678-1234-1234-1234-123456789abc';

describe('phone operation queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an exact pre-mutation device timeout without retrying work', async () => {
    vi.useFakeTimers();
    const registry = new LocalOperationRegistry();
    const work = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'late';
    });
    const pending = enqueueRegisteredPhoneOperation({
      deviceTimeoutMs: 10,
      kind: 'inspect_cart',
      registry,
      taskId,
    }, work);
    const outcome = pending.catch((value) => value);
    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error).toBeInstanceOf(StageDeadlineExceededError);
    expect(stageTimeoutOutcome(error)).toEqual({
      ok: false,
      recoveryAction: 'retry_safe',
      stage: 'device_automation',
      status: 'stage_timeout',
      timeoutMs: 10,
    });
    expect(work).toHaveBeenCalledOnce();
  });

  it('preserves a verified mutation that completes after its deadline', async () => {
    vi.useFakeTimers();
    const registry = new LocalOperationRegistry();
    const mutation = vi.fn(async (control: PhoneOperationExecutionControl) => {
      control.markMutationAttempted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      control.markReconciling();
      return 'verified';
    });
    const pending = enqueueRegisteredPhoneOperation({
      deviceTimeoutMs: 10,
      kind: 'add_cart_item',
      registry,
      taskId,
    }, mutation);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('verified');
    expect(mutation).toHaveBeenCalledOnce();
    expect(registry.listForTask(taskId)[0]).toMatchObject({
      mutationBoundary: 'verified',
      status: 'succeeded',
    });
  });

  it('separates queue wait from owned device execution latency', async () => {
    const ticks = [0, 5, 10, 30];
    const metrics = new DeterministicStageMetricsCollector({
      now: () => ticks.shift()!,
    });
    await enqueueRegisteredPhoneOperation({
      kind: 'inspect_cart',
      metrics,
      taskId,
    }, async () => 'done');

    expect(metrics.snapshot()).toEqual([
      expect.objectContaining({
        durationMs: 5,
        outcome: 'completed',
        stage: 'queue_wait',
      }),
      expect.objectContaining({
        durationMs: 20,
        outcome: 'completed',
        stage: 'device_automation',
      }),
    ]);
  });

  it('publishes observed queue, ownership, and terminal checkpoints in order', async () => {
    const checkpoints: string[] = [];
    await enqueueRegisteredPhoneOperation({
      kind: 'inspect_cart',
      onOwned: async (operation) => {
        checkpoints.push(`owned:${operation.status}`);
      },
      onQueued: async (operation) => {
        checkpoints.push(`queued:${operation.status}`);
      },
      onTerminal: async (operation) => {
        checkpoints.push(`terminal:${operation.status}`);
      },
      registry: new LocalOperationRegistry(),
      taskId,
    }, async () => 'done');

    expect(checkpoints).toEqual([
      'queued:queued',
      'owned:running',
      'terminal:succeeded',
    ]);
  });

  it('runs device operations one at a time', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = enqueuePhoneOperation(async () => {
      events.push('first:start');
      markFirstStarted?.();
      await firstCanFinish;
      events.push('first:end');
      return 1;
    });
    const second = enqueuePhoneOperation(async () => {
      events.push('second:start');
      events.push('second:end');
      return 2;
    });

    await firstStarted;
    expect(events).toEqual(['first:start']);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('creates operations before queueing and transfers ownership serially', async () => {
    const registry = new LocalOperationRegistry();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const hasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'inspect_cart',
      registry,
    }, async (control) => {
      events.push('first:owned');
      firstStarted?.();
      await firstCanFinish;
      expect(control.current().ownership).toBe('owned');
      return 1;
    });
    await hasStarted;
    const second = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'search_products',
      registry,
    }, async () => {
      events.push('second:owned');
      return 2;
    });

    expect(registry.listForTask(taskId).map((operation) => operation.status))
      .toEqual(['running', 'queued']);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:owned', 'second:owned']);
    expect(registry.listForTask(taskId).map((operation) => operation.status))
      .toEqual(['succeeded', 'succeeded']);
  });

  it('does not let a timed-out queue entry overtake the current owner', async () => {
    const registry = new LocalOperationRegistry();
    let releaseBlocker: (() => void) | undefined;
    const blocker = enqueuePhoneOperation(() => new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    }));
    while (!releaseBlocker) await Promise.resolve();
    const work = vi.fn(async () => undefined);
    const timedOut = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'inspect_cart',
      queueTimeoutMs: 5,
      registry,
    }, work);

    await expect(timedOut).rejects.toBeInstanceOf(
      PhoneOperationQueueTimeoutError,
    );
    expect(work).not.toHaveBeenCalled();
    expect(registry.listForTask(taskId)[0]?.status).toBe('failed');
    releaseBlocker?.();
    await blocker;
  });

  it('cancels before ownership without running phone work', async () => {
    const registry = new LocalOperationRegistry();
    let releaseBlocker: (() => void) | undefined;
    const blocker = enqueuePhoneOperation(() => new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    }));
    while (!releaseBlocker) await Promise.resolve();
    const work = vi.fn(async () => undefined);
    const pending = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'search_products',
      registry,
    }, work);
    await Promise.resolve();

    expect(cancelCurrentPhoneTask(taskId, registry)).toMatchObject({
      outcome: 'cancelled',
      policy: 'cancel_now',
    });
    releaseBlocker?.();
    await blocker;
    await expect(pending).rejects.toBeInstanceOf(
      PhoneOperationCancelledError,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('stops at a safe checkpoint but reconciles after mutation attempt', async () => {
    const beforeMutationRegistry = new LocalOperationRegistry();
    let continueToMutation: (() => void) | undefined;
    let owned: (() => void) | undefined;
    const mayMutate = new Promise<void>((resolve) => {
      continueToMutation = resolve;
    });
    const hasOwnership = new Promise<void>((resolve) => {
      owned = resolve;
    });
    const beforeMutation = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'add_cart_item',
      registry: beforeMutationRegistry,
    }, async (control) => {
      owned?.();
      await mayMutate;
      control.markMutationAttempted();
    });
    await hasOwnership;
    expect(cancelCurrentPhoneTask(taskId, beforeMutationRegistry))
      .toMatchObject({
        outcome: 'cancellation_requested',
        policy: 'stop_after_current_step',
      });
    continueToMutation?.();
    await expect(beforeMutation).rejects.toBeInstanceOf(
      PhoneOperationCancelledError,
    );

    const afterMutationRegistry = new LocalOperationRegistry();
    let mutationMarked: (() => void) | undefined;
    let finishReconciliation: (() => void) | undefined;
    const hasMutated = new Promise<void>((resolve) => {
      mutationMarked = resolve;
    });
    const canFinish = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const afterMutation = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'add_cart_item',
      registry: afterMutationRegistry,
    }, async (control) => {
      control.markMutationAttempted();
      mutationMarked?.();
      await canFinish;
      control.markReconciling();
      return 'verified';
    });
    await hasMutated;
    expect(cancelCurrentPhoneTask(taskId, afterMutationRegistry))
      .toMatchObject({
        outcome: 'reconcile_required',
        policy: 'reconcile_only',
      });
    finishReconciliation?.();
    await expect(afterMutation).resolves.toBe('verified');
    expect(afterMutationRegistry.listForTask(taskId)[0]).toMatchObject({
      mutationBoundary: 'verified',
      status: 'succeeded',
    });
  });

  it('exposes obsolescence so late work cannot publish to a newer task view', async () => {
    const registry = new LocalOperationRegistry();
    let current = true;
    const observed: boolean[] = [];
    const result = enqueueRegisteredPhoneOperation({
      taskId,
      kind: 'inspect_cart',
      registry,
      isCurrent: () => current,
    }, async (control) => {
      observed.push(control.isCurrent());
      current = false;
      observed.push(control.isCurrent());
      return 'late';
    });

    await expect(result).resolves.toBe('late');
    expect(observed).toEqual([true, false]);
    expect(registry.listForTask(taskId)[0]).toMatchObject({
      status: 'succeeded',
      step: 'obsolete operation completed without publishing',
    });
  });
});
