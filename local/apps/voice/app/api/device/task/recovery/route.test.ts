import { describe, expect, it, vi } from 'vitest';
import {
  companionIssueV2,
} from '../../../../../lib/progress/v2/companion-issue';
import {
  InMemoryPhoneTaskRepositoryV2,
  persistRecoveryHandoffV2,
  transitionPhoneTaskV2,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
} from '../../../../../lib/workflow/v2';
import type {
  BackgroundPhoneOperationRecordV2,
} from '../../../../../lib/workflow/v2/background-phone-operation/contracts';
import { validTaskV2 } from '../../../../../lib/workflow/v2/test-fixtures';
import {
  parseLocalIdentifier,
} from '../../../../../lib/workflow/identifiers';
import {
  handleRecoveryRequestV2,
  type RecoveryRouteDependenciesV2,
} from './route';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const operationId = parseLocalIdentifier(
  'operation',
  'operation_12345678-1234-1234-1234-123456789abc',
);
const interactionId = 'recovery_12345678';

function terminalOperation(input: {
  kind?: string;
  status?: 'ambiguous' | 'failed';
} = {}): BackgroundPhoneOperationRecordV2 {
  return {
    version: 2,
    operationId,
    taskId,
    taskRevision: 1,
    stepId: 'step:first',
    operationKind: input.kind ?? 'add_cart_item',
    requestPayload: { version: 1 },
    status: input.status ?? 'ambiguous',
    attempts: 1,
    recoveryCount: 0,
    createdAt: 2,
    updatedAt: 3,
    terminalAt: 3,
  };
}

function stoppedTask(kind = 'add_cart_item'): PhoneTaskV2 {
  const original = validTaskV2();
  original.taskId = taskId;
  original.clientId = 'pixel-overlay';
  original.steps[0] = {
    ...original.steps[0]!,
    kind,
    input: kind === 'search_products'
      ? { action: 'search_products', request: 'Amul milk' }
      : { action: kind },
  };
  const running = transitionPhoneTaskV2(original, {
    type: 'begin_step',
    stepId: 'step:first',
    operationId,
    entryId: 'journal:began',
    at: 2,
  });
  return transitionPhoneTaskV2(running, kind === 'search_products'
    ? {
        type: 'fail_step',
        stepId: 'step:first',
        resultRef: 'result:failed',
        entryId: 'journal:failed',
        at: 3,
      }
    : {
        type: 'mark_ambiguous',
        stepId: 'step:first',
        resultRef: 'result:ambiguous',
        entryId: 'journal:ambiguous',
        at: 3,
      });
}

async function setup(input: {
  expiresAt?: number;
  kind?: 'add_cart_item' | 'search_products';
} = {}): Promise<{
  dependencies: RecoveryRouteDependenciesV2;
  repository: PhoneTaskRepositoryV2;
}> {
  const kind = input.kind ?? 'add_cart_item';
  const task = stoppedTask(kind);
  const repository = new InMemoryPhoneTaskRepositoryV2({
    now: (): number => 10,
  });
  await repository.create({
    task,
    event: {
      eventId: 'event:terminal-operation',
      taskId,
      taskRevision: task.revision,
      at: task.updatedAt,
      kind: 'operation_terminal',
    },
    ...(kind === 'add_cart_item'
      ? {
          activeOperation: {
            operationId,
            taskId,
            stepId: 'step:first',
            kind,
            boundary: 'mutation_attempted' as const,
            status: 'ambiguous' as const,
            updatedAt: 3,
          },
        }
      : {}),
  });
  const issue = kind === 'search_products'
    ? companionIssueV2({ version: 2, stage: 'search', status: 'failed' })
    : companionIssueV2({ version: 2, stage: 'mutation', status: 'ambiguous' });
  await persistRecoveryHandoffV2({
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    interactionId,
    issue,
    now: () => 10,
    operation: terminalOperation({
      kind,
      status: kind === 'search_products' ? 'failed' : 'ambiguous',
    }),
    repository,
  });
  return {
    repository,
    dependencies: {
      diagnose: vi.fn(async () => ({ ready: true })),
      dispatchReadOnly: vi.fn(async () => ({ disposition: 'dispatched' })),
      now: () => 20,
      repository,
    },
  };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/device/task/recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 2,
      actionId: 'check_cart_again',
      clientId: 'pixel-overlay',
      interactionId,
      operationId,
      source: 'tap',
      stepId: 'step:first',
      taskId,
      taskRevision: 3,
      ...overrides,
    }),
  });
}

describe('POST /api/device/task/recovery', () => {
  it('turns ambiguous mutation recovery into one read-only cart inspection', async () => {
    const { dependencies, repository } = await setup();
    const response = await handleRecoveryRequestV2(request(), dependencies);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      acknowledgement: 'accepted',
      actionId: 'check_cart_again',
      taskRevision: 4,
      followup: { kind: 'read_only_operation', dispatched: true },
    });
    expect(dependencies.dispatchReadOnly).toHaveBeenCalledOnce();
    const stored = await repository.getById(taskId);
    expect(stored?.task).toMatchObject({
      status: 'active',
    });
    expect(stored?.task.pendingInteraction).toBeUndefined();
    expect(stored?.task.steps[0]).toMatchObject({
        stepId: 'step:first',
        kind: 'inspect_cart',
        status: 'ready',
        input: {
          action: 'inspect_cart',
          mode: 'read_only_reconciliation',
          reconcilesOperationId: operationId,
        },
        expectedPostcondition: {
          kind: 'cart_contents_observed',
          mutationReplay: false,
        },
    });
    expect(stored?.task.steps[0]?.operationId).toBeUndefined();
    expect(stored?.activeOperation).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('add_cart_item');
  });

  it('refreshes failed search choices without exposing a mutation retry', async () => {
    const { dependencies, repository } = await setup({
      kind: 'search_products',
    });
    const before = await repository.getById(taskId);
    expect(before?.task.pendingInteraction?.allowedResponses)
      .toMatchObject({
        actions: [
          { actionId: 'refresh_choices', safety: 'read_only' },
          { actionId: 'stop_task', safety: 'stop_only' },
        ],
      });
    expect(JSON.stringify(before)).not.toContain('retry_verified_not_applied');

    const response = await handleRecoveryRequestV2(request({
      actionId: 'refresh_choices',
    }), dependencies);

    expect(response.status).toBe(200);
    expect((await repository.getById(taskId))?.task.steps[0])
      .toMatchObject({
        kind: 'search_products',
        status: 'ready',
        input: { action: 'search_products', request: 'Amul milk' },
      });
    expect(dependencies.dispatchReadOnly).toHaveBeenCalledOnce();
  });

  it.each([
    ['reconnect_phone', 'diagnostics'],
    ['unlock_phone', 'guidance'],
    ['stop_task', 'stopped'],
  ] as const)(
    'resolves %s with the non-mutation follow-up %s',
    async (actionId, expectedKind) => {
      const { dependencies, repository } = await setup();
      const task = (await repository.getById(taskId))!.task;
      const allowed = task.pendingInteraction!.allowedResponses as {
        actions: Array<{ actionId: string; safety: string }>;
      };
      allowed.actions.splice(0, allowed.actions.length, {
        actionId,
        safety: actionId === 'stop_task'
          ? 'stop_only'
          : actionId === 'unlock_phone'
            ? 'user_guidance'
            : 'read_only',
      });
      task.pendingInteraction!.allowedResponses = allowed;
      const rewritten = new InMemoryPhoneTaskRepositoryV2({
        now: (): number => 10,
      });
      await rewritten.create({
        task,
        event: {
          eventId: 'event:custom-recovery',
          taskId,
          taskRevision: task.revision,
          at: task.updatedAt,
          kind: 'recovery_handoff',
        },
      });
      dependencies.repository = rewritten;

      const response = await handleRecoveryRequestV2(
        request({ actionId }),
        dependencies,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        acknowledgement: 'accepted',
        followup: { kind: expectedKind },
      });
      expect(dependencies.dispatchReadOnly).not.toHaveBeenCalled();
      if (actionId === 'reconnect_phone') {
        expect(dependencies.diagnose).toHaveBeenCalledOnce();
      }
      if (actionId === 'stop_task') {
        expect((await rewritten.getById(taskId))?.task.status)
          .toBe('cancelled');
      }
    },
  );

  it('is one-shot across duplicate, conflicting, and concurrent winners', async () => {
    const exact = await setup();
    expect((await handleRecoveryRequestV2(
      request(),
      exact.dependencies,
    )).status).toBe(200);
    const duplicate = await handleRecoveryRequestV2(
      request(),
      exact.dependencies,
    );
    expect(await duplicate.json()).toMatchObject({
      acknowledgement: 'duplicate',
      actionId: 'check_cart_again',
      taskRevision: 4,
    });
    const conflict = await handleRecoveryRequestV2(
      request({ actionId: 'stop_task' }),
      exact.dependencies,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      acknowledgement: 'rejected',
      reason: 'already_resolved',
    });

    const raced = await setup();
    const responses = await Promise.all([
      handleRecoveryRequestV2(request(), raced.dependencies),
      handleRecoveryRequestV2(request(), raced.dependencies),
    ]);
    const bodies = await Promise.all(responses.map((response) =>
      response.json()));
    expect(bodies.map((body) => body.acknowledgement).sort()).toEqual([
      'accepted',
      'duplicate',
    ]);
    expect(raced.dependencies.dispatchReadOnly).toHaveBeenCalledOnce();
  });

  it('rejects stale, expired, mismatched, unavailable, and malformed requests', async () => {
    const stale = await setup();
    expect((await handleRecoveryRequestV2(
      request({ taskRevision: 2 }),
      stale.dependencies,
    )).status).toBe(409);

    const expired = await setup({ expiresAt: 15 });
    const expiredResponse = await handleRecoveryRequestV2(
      request(),
      expired.dependencies,
    );
    expect(expiredResponse.status).toBe(409);
    await expect(expiredResponse.json()).resolves.toMatchObject({
      reason: 'expired',
    });

    const mismatched = await setup();
    expect((await handleRecoveryRequestV2(request({
      operationId:
        'operation_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    }), mismatched.dependencies)).status).toBe(409);
    expect((await handleRecoveryRequestV2(request({
      actionId: 'refresh_choices',
    }), mismatched.dependencies)).status).toBe(422);
    expect((await handleRecoveryRequestV2(request({
      actionId: 'retry_verified_not_applied',
    }), mismatched.dependencies)).status).toBe(400);
    expect((await handleRecoveryRequestV2(request({
      unexpected: true,
    }), mismatched.dependencies)).status).toBe(400);

    expect(mismatched.dependencies.dispatchReadOnly).not.toHaveBeenCalled();
    expect(mismatched.dependencies.diagnose).not.toHaveBeenCalled();
  });
});
