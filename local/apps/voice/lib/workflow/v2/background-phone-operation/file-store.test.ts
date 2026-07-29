import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetainedTaskEventStreamV2 } from '../../../progress/v2/retained-task-event-stream';
import { parseLocalIdentifier } from '../../identifiers';
import type {
  BackgroundPhoneOperationEnqueueInputV2,
  BackgroundPhoneOperationWorkerResultV2,
} from './contracts';
import { FileBackedBackgroundPhoneOperationStoreV2 } from './file-store';
import { BackgroundPhoneOperationManagerV2 } from './manager';

const taskId = parseLocalIdentifier('task', 'task_restart1');
const operationId = parseLocalIdentifier(
  'operation',
  'operation_restart1',
);
const directories: string[] = [];

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jaldi-background-op-'));
  directories.push(directory);
  return join(directory, 'operations.json');
}

function request(): BackgroundPhoneOperationEnqueueInputV2 {
  return {
    taskId,
    taskRevision: 7,
    stepId: 'phone-step',
    operationKind: 'phone_search',
    requestPayload: { query: 'atta' },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe('FileBackedBackgroundPhoneOperationStoreV2', () => {
  it('atomically restores and resumes an operation interrupted while running', async () => {
    const path = await statePath();
    const beforeCrash = new FileBackedBackgroundPhoneOperationStoreV2(path);
    await beforeCrash.enqueue({
      operationId,
      acceptedAt: 100,
      request: request(),
    });
    await beforeCrash.claim(operationId, 110);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      operations: [{ status: 'running' }],
    });

    const afterRestart = new FileBackedBackgroundPhoneOperationStoreV2(path);
    const stream = new RetainedTaskEventStreamV2({
      now: (): number => 130,
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store: afterRestart,
      stream,
      now: (): number => 120,
      worker: async (
        operation,
      ): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        expect(operation).toMatchObject({
          attempts: 2,
          recoveryCount: 1,
          status: 'running',
        });
        return { outcome: 'completed', resultRef: 'safe-result-ref' };
      },
    });

    await manager.initialize();
    await manager.awaitIdle();

    const durable = new FileBackedBackgroundPhoneOperationStoreV2(path);
    expect(await durable.get(operationId)).toMatchObject({
      status: 'completed',
      attempts: 2,
      recoveryCount: 1,
      resultRef: 'safe-result-ref',
      terminalEventPublishedAt: 130,
    });
    expect(stream.readAfter({ taskId }).events.at(-1)).toMatchObject({
      kind: 'completed',
      operationId,
    });

    const restartedStream = new RetainedTaskEventStreamV2({
      now: (): number => 140,
    });
    const secondRestart = new BackgroundPhoneOperationManagerV2({
      store: durable,
      stream: restartedStream,
      now: (): number => 140,
      worker: async (): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        throw new Error('Completed jobs must not execute again.');
      },
    });
    await secondRestart.initialize();
    expect(restartedStream.readAfter({ taskId }).events).toEqual([
      expect.objectContaining({
        kind: 'completed',
        operationId,
      }),
    ]);
  });

  it('replays a retained terminal event after a crash between commit and publish', async () => {
    const path = await statePath();
    const beforeCrash = new FileBackedBackgroundPhoneOperationStoreV2(path);
    await beforeCrash.enqueue({
      operationId,
      acceptedAt: 100,
      request: request(),
    });
    await beforeCrash.claim(operationId, 110);
    await beforeCrash.complete({
      operationId,
      outcome: 'ambiguous',
      terminalAt: 120,
      detail: 'Provider state requires reconciliation.',
    });

    const afterRestart = new FileBackedBackgroundPhoneOperationStoreV2(path);
    const stream = new RetainedTaskEventStreamV2({
      now: (): number => 130,
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store: afterRestart,
      stream,
      now: (): number => 130,
      worker: async (): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        throw new Error('Terminal jobs must not execute again.');
      },
    });

    await manager.initialize();

    expect(stream.readAfter({ taskId }).events).toEqual([
      expect.objectContaining({
        kind: 'ambiguous',
        operationId,
      }),
    ]);
    expect(await afterRestart.get(operationId)).toMatchObject({
      status: 'ambiguous',
      terminalEventPublishedAt: 130,
    });
  });

  it('never requeues a mutation that may have started before a crash', async () => {
    const path = await statePath();
    const beforeCrash = new FileBackedBackgroundPhoneOperationStoreV2(path);
    await beforeCrash.enqueue({
      operationId,
      acceptedAt: 100,
      request: request(),
    });
    await beforeCrash.claim(operationId, 110);
    await beforeCrash.markMutationAttempted(operationId, 120);
    await beforeCrash.markMutationAttempted(operationId, 125);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      operations: [{
        status: 'mutation_attempted',
        attempts: 1,
        mutationAttemptedAt: 120,
      }],
    });

    const executeAfterRestart = vi.fn();
    const afterRestart = new FileBackedBackgroundPhoneOperationStoreV2(path);
    const stream = new RetainedTaskEventStreamV2({
      now: (): number => 140,
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store: afterRestart,
      stream,
      now: (): number => 130,
      worker: executeAfterRestart,
    });

    await manager.initialize();
    await manager.awaitIdle();

    expect(executeAfterRestart).not.toHaveBeenCalled();
    expect(await afterRestart.listQueued()).toEqual([]);
    expect(await afterRestart.get(operationId)).toMatchObject({
      status: 'ambiguous',
      attempts: 1,
      recoveryCount: 1,
      mutationAttemptedAt: 120,
      terminalAt: 130,
      detail: expect.stringContaining('read-only reconciliation'),
    });
    expect(stream.readAfter({ taskId }).events).toEqual([
      expect.objectContaining({
        kind: 'ambiguous',
        operationId,
      }),
    ]);
  });
});
