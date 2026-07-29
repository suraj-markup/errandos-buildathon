import { describe, expect, it } from 'vitest';
import {
  cancellationPolicyFor,
  DuplicateLocalPhoneOperationError,
  InvalidLocalPhoneOperationTransitionError,
  LocalOperationRegistry,
} from './registry';

const operationId = (suffix: string) => `operation_12345678-${suffix}`;
const taskId = 'task_12345678-1234-1234-1234-123456789abc';
const itemId = 'task_item_12345678-1234-1234-1234-123456789abc';

function createRegistry(options: {
  maxTerminalHistory?: number;
  terminalTtlMs?: number;
} = {}) {
  let now = 1_000;
  const registry = new LocalOperationRegistry({
    ...options,
    now: () => now,
  });
  return {
    advanceBy(milliseconds: number) {
      now += milliseconds;
    },
    registry,
  };
}

describe('local operation registry', () => {
  it('binds a queued operation to one task and optional item', () => {
    const { registry } = createRegistry();
    const operation = registry.create({
      operationId: operationId('1234-1234-1234-123456789abc'),
      taskId,
      itemId,
      kind: 'add_cart_item',
      step: 'Waiting for device',
    });

    expect(operation).toMatchObject({
      version: 1,
      taskId,
      itemId,
      kind: 'add_cart_item',
      status: 'queued',
      step: 'Waiting for device',
      sequence: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(registry.listForTask(taskId)).toEqual([operation]);
  });

  it('accepts the legal mutation and reconciliation lifecycle', () => {
    const { advanceBy, registry } = createRegistry();
    const queued = registry.create({
      operationId: operationId('2234-1234-1234-123456789abc'),
      taskId,
      itemId,
      kind: 'add_cart_item',
    });

    advanceBy(1);
    const running = registry.transition(queued.operationId, {
      status: 'running',
      step: 'Opening Blinkit',
    });
    advanceBy(1);
    const mutated = registry.transition(queued.operationId, {
      status: 'mutation_attempted',
      step: 'Tapped Add',
    });
    advanceBy(1);
    const reconciling = registry.transition(queued.operationId, {
      status: 'reconciling',
      step: 'Reading cart',
    });
    advanceBy(1);
    const retried = registry.transition(queued.operationId, {
      status: 'mutation_attempted',
      step: 'Reapplied desired quantity after unchanged-cart proof',
    });
    advanceBy(1);
    const verifyingRetry = registry.transition(queued.operationId, {
      status: 'reconciling',
      step: 'Reading cart after retry',
    });
    advanceBy(1);
    const succeeded = registry.transition(queued.operationId, {
      status: 'succeeded',
      step: 'Cart verified',
    });

    expect([
      queued.sequence,
      running.sequence,
      mutated.sequence,
      reconciling.sequence,
      retried.sequence,
      verifyingRetry.sequence,
      succeeded.sequence,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(running.startedAt).toBe(1_001);
    expect(succeeded.finishedAt).toBe(1_006);
    expect(registry.get(queued.operationId)).toEqual(succeeded);
  });

  it('allows a read-only operation to wait for the user and resume', () => {
    const { registry } = createRegistry();
    const operation = registry.create({
      operationId: operationId('3234-1234-1234-123456789abc'),
      taskId,
      kind: 'search_products',
    });

    registry.transition(operation.operationId, { status: 'running' });
    const waiting = registry.transition(operation.operationId, {
      status: 'waiting_for_user',
    });
    const resumed = registry.transition(operation.operationId, {
      status: 'running',
    });

    expect(waiting.sequence).toBe(2);
    expect(resumed.sequence).toBe(3);
    expect(resumed.startedAt).toBe(1_000);
  });

  it('rejects illegal reversals and cancellation after mutation attempt', () => {
    const { registry } = createRegistry();
    const operation = registry.create({
      operationId: operationId('4234-1234-1234-123456789abc'),
      taskId,
      itemId,
      kind: 'add_cart_item',
    });
    registry.transition(operation.operationId, { status: 'running' });
    registry.transition(operation.operationId, {
      status: 'mutation_attempted',
    });

    expect(cancellationPolicyFor(registry.require(operation.operationId)))
      .toBe('reconcile_only');
    expect(registry.requestCancellation(operation.operationId)).toMatchObject({
      outcome: 'reconcile_required',
      policy: 'reconcile_only',
    });
    expect(() => registry.transition(operation.operationId, {
      status: 'running',
    })).toThrow(InvalidLocalPhoneOperationTransitionError);
    expect(() => registry.transition(operation.operationId, {
      status: 'cancelled',
    })).toThrow(InvalidLocalPhoneOperationTransitionError);
  });

  it('derives cancellation from ownership and mutation boundaries', () => {
    const { registry } = createRegistry();
    const queued = registry.create({
      operationId: operationId('d234-1234-1234-123456789abc'),
      taskId,
      itemId,
      kind: 'add_cart_item',
    });
    expect(queued.cancellationPolicy).toBe('cancel_now');

    const owned = registry.transition(queued.operationId, {
      status: 'running',
    });
    expect(owned).toMatchObject({
      cancellationPolicy: 'stop_after_current_step',
      mutationBoundary: 'before_mutation',
      ownership: 'owned',
    });

    const requested = registry.requestCancellation(queued.operationId);
    expect(requested).toMatchObject({
      outcome: 'cancellation_requested',
      policy: 'stop_after_current_step',
    });
    expect(registry.cancelAtCheckpoint(queued.operationId)).toMatchObject({
      status: 'cancelled',
      ownership: 'released',
    });
    expect(registry.requestCancellation(queued.operationId).outcome)
      .toBe('already_cancelled');
  });

  it('makes final order dispatch non-cancellable', () => {
    const { registry } = createRegistry();
    const operation = registry.create({
      operationId: operationId('e234-1234-1234-123456789abc'),
      taskId,
      kind: 'confirm_order',
    });
    registry.transition(operation.operationId, { status: 'running' });
    const dispatched = registry.markFinalDispatchAttempted(
      operation.operationId,
    );

    expect(dispatched).toMatchObject({
      cancellationPolicy: 'not_cancellable',
      mutationBoundary: 'final_dispatch_attempted',
      status: 'mutation_attempted',
    });
    expect(registry.requestCancellation(operation.operationId)).toMatchObject({
      outcome: 'not_cancellable',
      policy: 'not_cancellable',
    });
  });

  it('makes duplicate terminal writes idempotent without advancing time or sequence', () => {
    const { advanceBy, registry } = createRegistry();
    const operation = registry.create({
      operationId: operationId('5234-1234-1234-123456789abc'),
      taskId,
      kind: 'inspect_cart',
    });
    registry.transition(operation.operationId, { status: 'running' });
    const terminal = registry.transition(operation.operationId, {
      status: 'succeeded',
      step: 'Cart read',
    });

    advanceBy(500);
    const duplicate = registry.transition(operation.operationId, {
      status: 'succeeded',
      step: 'A late duplicate',
    });

    expect(duplicate).toEqual(terminal);
    expect(duplicate.sequence).toBe(2);
    expect(duplicate.step).toBe('Cart read');
    expect(() => registry.transition(operation.operationId, {
      status: 'failed',
    })).toThrow(InvalidLocalPhoneOperationTransitionError);
  });

  it('expires terminal operations without expiring active operations', () => {
    const { advanceBy, registry } = createRegistry({ terminalTtlMs: 100 });
    const terminal = registry.create({
      operationId: operationId('6234-1234-1234-123456789abc'),
      taskId,
      kind: 'inspect_cart',
    });
    const active = registry.create({
      operationId: operationId('7234-1234-1234-123456789abc'),
      taskId,
      kind: 'search_products',
    });
    registry.transition(terminal.operationId, { status: 'cancelled' });

    advanceBy(99);
    expect(registry.get(terminal.operationId)).toBeDefined();
    advanceBy(1);
    expect(registry.get(terminal.operationId)).toBeUndefined();
    expect(registry.get(active.operationId)?.status).toBe('queued');
  });

  it('bounds terminal history by completion order', () => {
    const { registry } = createRegistry({ maxTerminalHistory: 2 });
    const operations = [8, 9, 10].map((number) => registry.create({
      operationId: operationId(`${number}234-1234-1234-123456789abc`),
      taskId,
      kind: 'inspect_cart' as const,
    }));

    for (const operation of operations) {
      registry.transition(operation.operationId, { status: 'cancelled' });
    }

    expect(registry.get(operations[0]!.operationId)).toBeUndefined();
    expect(registry.get(operations[1]!.operationId)).toBeDefined();
    expect(registry.get(operations[2]!.operationId)).toBeDefined();
  });

  it('does not expose mutable registry records to callers', () => {
    const { registry } = createRegistry();
    const created = registry.create({
      operationId: operationId('a234-1234-1234-123456789abc'),
      taskId,
      kind: 'search_products',
    });
    created.status = 'succeeded';
    created.sequence = 99;

    expect(registry.get(created.operationId)).toMatchObject({
      status: 'queued',
      sequence: 0,
    });
  });

  it('rejects duplicate operation identifiers and malformed bindings', () => {
    const { registry } = createRegistry();
    const id = operationId('b234-1234-1234-123456789abc');
    registry.create({
      operationId: id,
      taskId,
      kind: 'search_products',
    });

    expect(() => registry.create({
      operationId: id,
      taskId,
      kind: 'search_products',
    })).toThrow(DuplicateLocalPhoneOperationError);
    expect(() => registry.create({
      operationId: operationId('c234-1234-1234-123456789abc'),
      taskId: 'task_wrong',
      kind: 'search_products',
    })).toThrow();
  });
});
