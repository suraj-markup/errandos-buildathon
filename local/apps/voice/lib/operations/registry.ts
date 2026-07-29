import {
  newLocalIdentifier,
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../workflow/identifiers';

const localPhoneOperationKinds = [
  'search_products',
  'inspect_cart',
  'add_cart_item',
  'set_cart_item_quantity',
  'remove_cart_item',
  'prepare_checkout',
  'confirm_order',
  'capture_screen_observation',
] as const;

export type LocalPhoneOperationKind =
  (typeof localPhoneOperationKinds)[number];

const localPhoneOperationStatuses = [
  'queued',
  'running',
  'waiting_for_user',
  'mutation_attempted',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
  'ambiguous',
] as const;

type LocalPhoneOperationStatus =
  (typeof localPhoneOperationStatuses)[number];

type LocalPhoneOperationTerminalStatus = Extract<
  LocalPhoneOperationStatus,
  'succeeded' | 'failed' | 'cancelled' | 'ambiguous'
>;

type LocalPhoneOperationCancellationPolicy =
  | 'cancel_now'
  | 'stop_after_current_step'
  | 'reconcile_only'
  | 'not_cancellable';

type LocalPhoneOperationMutationBoundary =
  | 'not_started'
  | 'before_mutation'
  | 'mutation_attempted'
  | 'verified'
  | 'final_dispatch_attempted';

type LocalPhoneOperationOwnership =
  | 'waiting_for_ownership'
  | 'owned'
  | 'released';

export type LocalPhoneOperationV1 = {
  version: 1;
  operationId: LocalIdentifier<'operation'>;
  taskId: LocalIdentifier<'task'>;
  itemId?: LocalIdentifier<'task_item'>;
  stepId?: string;
  kind: LocalPhoneOperationKind;
  status: LocalPhoneOperationStatus;
  step: string;
  sequence: number;
  cancellationPolicy: LocalPhoneOperationCancellationPolicy;
  mutationBoundary: LocalPhoneOperationMutationBoundary;
  ownership: LocalPhoneOperationOwnership;
  cancellationRequestedAt?: number;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
};

type CreateLocalPhoneOperationInput = {
  operationId?: LocalIdentifier<'operation'> | string;
  taskId: LocalIdentifier<'task'> | string;
  itemId?: LocalIdentifier<'task_item'> | string;
  stepId?: string;
  kind: LocalPhoneOperationKind;
  step?: string;
};

type TransitionLocalPhoneOperationInput = {
  status: Exclude<LocalPhoneOperationStatus, 'queued'>;
  step?: string;
};

type LocalOperationRegistryOptions = {
  maxTerminalHistory?: number;
  terminalTtlMs?: number;
  now?: () => number;
  newOperationId?: () => LocalIdentifier<'operation'>;
};

export type CancelLocalPhoneOperationResult = {
  operation: LocalPhoneOperationV1;
  outcome:
    | 'already_cancelled'
    | 'cancelled'
    | 'cancellation_requested'
    | 'not_cancellable'
    | 'reconcile_required';
  policy: LocalPhoneOperationCancellationPolicy;
};

const terminalStatuses = new Set<LocalPhoneOperationStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'ambiguous',
]);

const mutatingOperationKinds = new Set<LocalPhoneOperationKind>([
  'add_cart_item',
  'set_cart_item_quantity',
  'remove_cart_item',
]);

const legalTransitions: Readonly<
  Record<LocalPhoneOperationStatus, ReadonlySet<LocalPhoneOperationStatus>>
> = {
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set([
    'waiting_for_user',
    'mutation_attempted',
    'reconciling',
    'succeeded',
    'failed',
    'cancelled',
    'ambiguous',
  ]),
  waiting_for_user: new Set(['running', 'failed', 'cancelled', 'ambiguous']),
  mutation_attempted: new Set([
    'reconciling',
    'succeeded',
    'failed',
    'ambiguous',
  ]),
  reconciling: new Set([
    'mutation_attempted',
    'succeeded',
    'failed',
    'ambiguous',
  ]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  ambiguous: new Set(),
};

const defaultStepByStatus: Readonly<Record<LocalPhoneOperationStatus, string>> = {
  queued: 'queued',
  running: 'running',
  waiting_for_user: 'waiting for user',
  mutation_attempted: 'mutation attempted',
  reconciling: 'reconciling',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  ambiguous: 'outcome ambiguous',
};

export function isTerminalOperationStatus(
  status: LocalPhoneOperationStatus,
): status is LocalPhoneOperationTerminalStatus {
  return terminalStatuses.has(status);
}

export function cancellationPolicyFor(
  operation: Pick<
    LocalPhoneOperationV1,
    'kind' | 'mutationBoundary' | 'ownership' | 'status'
  >,
): LocalPhoneOperationCancellationPolicy {
  if (isTerminalOperationStatus(operation.status)) return 'not_cancellable';
  if (operation.mutationBoundary === 'final_dispatch_attempted') {
    return 'not_cancellable';
  }
  if (
    operation.mutationBoundary === 'mutation_attempted'
    || operation.status === 'mutation_attempted'
    || operation.status === 'reconciling'
  ) {
    return 'reconcile_only';
  }
  if (operation.ownership === 'waiting_for_ownership') return 'cancel_now';
  if (
    mutatingOperationKinds.has(operation.kind)
    && operation.mutationBoundary === 'before_mutation'
  ) {
    return 'stop_after_current_step';
  }
  return 'cancel_now';
}

export class DuplicateLocalPhoneOperationError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} already exists.`);
    this.name = 'DuplicateLocalPhoneOperationError';
  }
}

class LocalPhoneOperationNotFoundError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} was not found.`);
    this.name = 'LocalPhoneOperationNotFoundError';
  }
}

export class InvalidLocalPhoneOperationTransitionError extends Error {
  constructor(
    readonly operationId: string,
    readonly from: LocalPhoneOperationStatus,
    readonly to: LocalPhoneOperationStatus,
  ) {
    super(`Cannot transition operation ${operationId} from ${from} to ${to}.`);
    this.name = 'InvalidLocalPhoneOperationTransitionError';
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertOperationKind(
  value: unknown,
): asserts value is LocalPhoneOperationKind {
  if (!localPhoneOperationKinds.includes(value as LocalPhoneOperationKind)) {
    throw new Error('Invalid local phone operation kind.');
  }
}

function normalizedStep(
  step: string | undefined,
  status: LocalPhoneOperationStatus,
): string {
  if (step === undefined) return defaultStepByStatus[status];
  const normalized = step.trim();
  if (!normalized) throw new Error('Operation step cannot be empty.');
  return normalized;
}

function normalizedStepId(stepId: string | undefined): string | undefined {
  if (stepId === undefined) return undefined;
  const normalized = stepId.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error('Operation stepId must contain 1 to 240 characters.');
  }
  return normalized;
}

function cloneOperation(
  operation: LocalPhoneOperationV1,
): LocalPhoneOperationV1 {
  return { ...operation };
}

/**
 * Local, process-bound operation lifecycle storage.
 *
 * Active operations are retained until they reach a terminal status. Terminal
 * operations are bounded independently by both age and count. All returned
 * values are copies so callers cannot mutate registry state outside a legal
 * transition.
 */
export class LocalOperationRegistry {
  private readonly operations = new Map<string, LocalPhoneOperationV1>();
  private readonly terminalOrder: string[] = [];
  private readonly maxTerminalHistory: number;
  private readonly terminalTtlMs: number;
  private readonly now: () => number;
  private readonly newOperationId: () => LocalIdentifier<'operation'>;

  constructor(options: LocalOperationRegistryOptions = {}) {
    this.maxTerminalHistory = options.maxTerminalHistory ?? 100;
    this.terminalTtlMs = options.terminalTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.newOperationId = options.newOperationId
      ?? (() => newLocalIdentifier('operation'));
    assertPositiveInteger(this.maxTerminalHistory, 'maxTerminalHistory');
    assertPositiveInteger(this.terminalTtlMs, 'terminalTtlMs');
  }

  create(input: CreateLocalPhoneOperationInput): LocalPhoneOperationV1 {
    const now = this.now();
    this.prune(now);
    assertOperationKind(input.kind);
    const operationId = input.operationId
      ? parseLocalIdentifier('operation', input.operationId)
      : parseLocalIdentifier('operation', this.newOperationId());
    const taskId = parseLocalIdentifier('task', input.taskId);
    const itemId = input.itemId
      ? parseLocalIdentifier('task_item', input.itemId)
      : undefined;
    const stepId = normalizedStepId(input.stepId);

    if (this.operations.has(operationId)) {
      throw new DuplicateLocalPhoneOperationError(operationId);
    }

    const operation: LocalPhoneOperationV1 = {
      version: 1,
      operationId,
      taskId,
      ...(itemId ? { itemId } : {}),
      ...(stepId ? { stepId } : {}),
      kind: input.kind,
      status: 'queued',
      step: normalizedStep(input.step, 'queued'),
      sequence: 0,
      cancellationPolicy: 'cancel_now',
      mutationBoundary: 'not_started',
      ownership: 'waiting_for_ownership',
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(operationId, operation);
    return cloneOperation(operation);
  }

  get(
    operationId: LocalIdentifier<'operation'> | string,
  ): LocalPhoneOperationV1 | undefined {
    const now = this.now();
    this.prune(now);
    const parsedId = parseLocalIdentifier('operation', operationId);
    const operation = this.operations.get(parsedId);
    return operation ? cloneOperation(operation) : undefined;
  }

  require(
    operationId: LocalIdentifier<'operation'> | string,
  ): LocalPhoneOperationV1 {
    const operation = this.get(operationId);
    if (!operation) {
      throw new LocalPhoneOperationNotFoundError(String(operationId));
    }
    return operation;
  }

  transition(
    operationId: LocalIdentifier<'operation'> | string,
    input: TransitionLocalPhoneOperationInput,
  ): LocalPhoneOperationV1 {
    const now = this.now();
    this.prune(now);
    const parsedId = parseLocalIdentifier('operation', operationId);
    const current = this.operations.get(parsedId);
    if (!current) throw new LocalPhoneOperationNotFoundError(parsedId);

    if (isTerminalOperationStatus(current.status)) {
      if (current.status === input.status) {
        return cloneOperation(current);
      }
      throw new InvalidLocalPhoneOperationTransitionError(
        parsedId,
        current.status,
        input.status,
      );
    }

    if (!legalTransitions[current.status].has(input.status)) {
      throw new InvalidLocalPhoneOperationTransitionError(
        parsedId,
        current.status,
        input.status,
      );
    }

    const next: LocalPhoneOperationV1 = {
      ...current,
      status: input.status,
      step: normalizedStep(input.step, input.status),
      sequence: current.sequence + 1,
      ...(input.status === 'running'
        ? {
            ownership: 'owned' as const,
            ...(mutatingOperationKinds.has(current.kind)
              ? { mutationBoundary: 'before_mutation' as const }
              : {}),
          }
        : {}),
      ...(input.status === 'mutation_attempted'
        ? { mutationBoundary: 'mutation_attempted' as const }
        : {}),
      ...(input.status === 'reconciling'
        ? { mutationBoundary: 'mutation_attempted' as const }
        : {}),
      ...(input.status === 'succeeded' && mutatingOperationKinds.has(current.kind)
        ? { mutationBoundary: 'verified' as const }
        : {}),
      ...(isTerminalOperationStatus(input.status)
        ? { ownership: 'released' as const }
        : {}),
      ...(current.startedAt === undefined && input.status === 'running'
        ? { startedAt: now }
        : {}),
      updatedAt: now,
      ...(isTerminalOperationStatus(input.status) ? { finishedAt: now } : {}),
    };
    next.cancellationPolicy = cancellationPolicyFor(next);
    this.operations.set(parsedId, next);

    if (isTerminalOperationStatus(input.status)) {
      this.terminalOrder.push(parsedId);
      this.prune(now);
    }
    return cloneOperation(next);
  }

  markFinalDispatchAttempted(
    operationId: LocalIdentifier<'operation'> | string,
    step = 'final dispatch attempted',
  ): LocalPhoneOperationV1 {
    const current = this.require(operationId);
    if (
      current.kind !== 'confirm_order'
      || current.status !== 'running'
      || current.ownership !== 'owned'
    ) {
      throw new InvalidLocalPhoneOperationTransitionError(
        current.operationId,
        current.status,
        'mutation_attempted',
      );
    }
    return this.replace(current, {
      status: 'mutation_attempted',
      step,
      mutationBoundary: 'final_dispatch_attempted',
    });
  }

  requestCancellation(
    operationId: LocalIdentifier<'operation'> | string,
  ): CancelLocalPhoneOperationResult {
    const current = this.require(operationId);
    if (current.status === 'cancelled') {
      return {
        operation: current,
        outcome: 'already_cancelled',
        policy: 'not_cancellable',
      };
    }
    const policy = cancellationPolicyFor(current);
    if (policy === 'not_cancellable') {
      return { operation: current, outcome: 'not_cancellable', policy };
    }
    if (policy === 'reconcile_only') {
      return { operation: current, outcome: 'reconcile_required', policy };
    }
    if (current.cancellationRequestedAt !== undefined) {
      return {
        operation: current,
        outcome: 'cancellation_requested',
        policy,
      };
    }
    if (current.status === 'queued') {
      const cancelled = this.transition(current.operationId, {
        status: 'cancelled',
        step: 'cancelled before phone ownership',
      });
      return { operation: cancelled, outcome: 'cancelled', policy };
    }
    const requested = this.replace(current, {
      cancellationRequestedAt: this.now(),
      step: 'cancellation requested',
    });
    return {
      operation: requested,
      outcome: 'cancellation_requested',
      policy,
    };
  }

  cancelAtCheckpoint(
    operationId: LocalIdentifier<'operation'> | string,
    step = 'cancelled at safe checkpoint',
  ): LocalPhoneOperationV1 | undefined {
    const current = this.require(operationId);
    if (current.status === 'cancelled') return current;
    if (current.cancellationRequestedAt === undefined) return undefined;
    const policy = cancellationPolicyFor(current);
    if (policy === 'reconcile_only' || policy === 'not_cancellable') {
      return undefined;
    }
    return this.transition(current.operationId, {
      status: 'cancelled',
      step,
    });
  }

  latestActiveForTask(
    taskId: LocalIdentifier<'task'> | string,
  ): LocalPhoneOperationV1 | undefined {
    return this.listForTask(taskId)
      .filter((operation) => !isTerminalOperationStatus(operation.status))
      .sort((left, right) => (
        right.createdAt - left.createdAt
        || right.operationId.localeCompare(left.operationId)
      ))[0];
  }

  listForTask(
    taskId: LocalIdentifier<'task'> | string,
  ): LocalPhoneOperationV1[] {
    const now = this.now();
    this.prune(now);
    const parsedTaskId = parseLocalIdentifier('task', taskId);
    return [...this.operations.values()]
      .filter((operation) => operation.taskId === parsedTaskId)
      .sort((left, right) => (
        left.createdAt - right.createdAt
        || left.operationId.localeCompare(right.operationId)
      ))
      .map(cloneOperation);
  }

  cleanup(): number {
    return this.prune(this.now());
  }

  private replace(
    current: LocalPhoneOperationV1,
    changes: Partial<LocalPhoneOperationV1>,
  ): LocalPhoneOperationV1 {
    const now = this.now();
    const next: LocalPhoneOperationV1 = {
      ...current,
      ...changes,
      sequence: current.sequence + 1,
      updatedAt: now,
    };
    next.cancellationPolicy = cancellationPolicyFor(next);
    this.operations.set(current.operationId, next);
    return cloneOperation(next);
  }

  private prune(now: number): number {
    let removed = 0;
    while (this.terminalOrder.length > 0) {
      const operationId = this.terminalOrder[0]!;
      const operation = this.operations.get(operationId);
      if (!operation || operation.finishedAt === undefined) {
        this.terminalOrder.shift();
        continue;
      }
      const expired = now - operation.finishedAt >= this.terminalTtlMs;
      const overCapacity =
        this.terminalOrder.length > this.maxTerminalHistory;
      if (!expired && !overCapacity) break;
      this.terminalOrder.shift();
      if (this.operations.delete(operationId)) removed += 1;
    }
    return removed;
  }
}
