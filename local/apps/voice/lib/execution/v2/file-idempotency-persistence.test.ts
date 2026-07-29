import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type {
  CartSnapshotV2,
  DesiredCartStateV2,
} from './contracts';
import { CartMutationExecutionTruthServiceV2 } from './cart-mutation-execution-truth';
import { FileOperationIdempotencyPersistenceV2 } from './file-idempotency-persistence';
import { OperationIdempotencyRegistryV2 } from './idempotency-records';
import {
  classifyObservedCartMutationV2,
  unverifiedCartMutationV2,
} from './mutation-outcomes';

const temporaryDirectories: string[] = [];
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const itemId = parseLocalIdentifier(
  'task_item',
  'task_item_12345678-1234-1234-1234-123456789abc',
);
const operationIds = [
  'operation_12345678-1234-1234-1234-123456789ab1',
  'operation_12345678-1234-1234-1234-123456789ab2',
  'operation_12345678-1234-1234-1234-123456789ab3',
].map((value) => parseLocalIdentifier('operation', value));

const desired: DesiredCartStateV2 = {
  version: 2,
  taskId,
  itemId,
  stepKey: 'item.0.add',
  offerId: 'offer_milk',
  targetQuantity: 2,
};

function snapshot(
  observationId: string,
  capturedAt: number,
  quantity: number,
): CartSnapshotV2 {
  return {
    version: 2,
    observationId,
    capturedAt,
    lines: quantity > 0
      ? [{ offerId: desired.offerId, quantity }]
      : [],
  };
}

async function persistencePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'errandos-idempotency-'));
  temporaryDirectories.push(directory);
  return join(directory, '.runtime', 'cart-mutation-idempotency-v2.json');
}

function registry(input: {
  filePath: string;
  idIndex?: number;
  maxRecords?: number;
  now?: () => number;
  recordTtlMs?: number;
}) {
  let idIndex = input.idIndex ?? 0;
  return new OperationIdempotencyRegistryV2({
    persistence: new FileOperationIdempotencyPersistenceV2(
      input.filePath,
      { now: input.now },
    ),
    newOperationId: () => operationIds[idIndex++]!,
    ...(input.maxRecords ? { maxRecords: input.maxRecords } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.recordTtlMs
      ? { recordTtlMs: input.recordTtlMs }
      : {}),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe('file operation idempotency persistence v2', () => {
  it('preserves duplicate suppression and the one-time advance claim across restart', async () => {
    const filePath = await persistencePath();
    const first = registry({ filePath });
    const registered = first.register({ callId: 'call-a', desired });
    const before = snapshot('before', 100, 0);
    const verified = classifyObservedCartMutationV2({
      before,
      after: snapshot('after', 200, 2),
      desired,
      mutationAttempted: true,
    });
    if (verified.kind !== 'verified') throw new Error('Expected verification.');
    first.recordAttemptOutcome(registered.record.operationId, verified);
    expect(first.claimVerifiedAdvance(registered.record.operationId).claimed)
      .toBe(true);

    const restarted = registry({ filePath, idIndex: 1 });
    expect(restarted.register({
      callId: 'call-after-restart',
      desired,
    })).toMatchObject({
      accepted: false,
      disposition: 'semantic_duplicate',
      record: { operationId: registered.record.operationId },
    });
    expect(
      restarted.claimVerifiedAdvance(registered.record.operationId).claimed,
    ).toBe(false);
  });

  it('restores an unresolved mutation and reconciles without blind replay', async () => {
    const filePath = await persistencePath();
    const first = registry({ filePath });
    const before = snapshot('before', 100, 0);
    const registered = first.register({ callId: 'call-a', desired });
    first.recordAttemptOutcome(
      registered.record.operationId,
      unverifiedCartMutationV2({
        before,
        desired,
        reason: 'verification_interrupted',
      }),
    );

    const restartedTruth = new CartMutationExecutionTruthServiceV2(
      registry({ filePath, idIndex: 1 }),
    );
    const prepared = restartedTruth.prepare({
      before,
      callId: 'call-after-restart',
      desired,
    });
    expect(prepared.action).toBe('reconcile');
    const reconciled = restartedTruth.reconcile({
      before,
      current: snapshot('fresh-after-restart', 300, 2),
      desired,
      operationId: registered.record.operationId,
    });
    expect(reconciled.action).toBe('advance');

    const secondRestart = new CartMutationExecutionTruthServiceV2(
      registry({ filePath, idIndex: 2 }),
    );
    expect(secondRestart.prepare({
      before: snapshot('latest', 400, 2),
      callId: 'call-second-restart',
      desired,
    }).action).toBe('completed');
  });

  it('fails closed to an empty registry on corrupt or forged persistence', async () => {
    const filePath = await persistencePath();
    const first = registry({ filePath });
    first.register({ callId: 'call-a', desired });
    const envelope = JSON.parse(await readFile(filePath, 'utf8'));
    envelope.document.records[0].advanceClaimedAt = 1;
    await writeFile(filePath, JSON.stringify(envelope), 'utf8');

    const restarted = registry({ filePath, idIndex: 1 });
    expect(restarted.register({
      callId: 'call-a',
      desired,
    })).toMatchObject({
      accepted: true,
      disposition: 'created',
      record: { operationId: operationIds[1] },
    });
    const repaired = JSON.parse(await readFile(filePath, 'utf8'));
    expect(repaired).toMatchObject({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      document: {
        schemaVersion: 2,
        records: [expect.objectContaining({
          operationId: operationIds[1],
        })],
      },
    });
  });

  it('serializes interleaved writers without losing records or double-advancing', async () => {
    const filePath = await persistencePath();
    const writerA = registry({ filePath, idIndex: 0 });
    const writerB = registry({ filePath, idIndex: 1 });
    const first = writerA.register({ callId: 'call-a', desired });
    writerB.register({
      callId: 'call-b',
      desired: { ...desired, targetQuantity: 3 },
    });
    const before = snapshot('before', 100, 0);
    const verified = classifyObservedCartMutationV2({
      before,
      after: snapshot('after', 200, 2),
      desired,
      mutationAttempted: true,
    });
    if (verified.kind !== 'verified') throw new Error('Expected verification.');
    writerA.recordAttemptOutcome(first.record.operationId, verified);

    expect(writerA.claimVerifiedAdvance(first.record.operationId).claimed)
      .toBe(true);
    expect(writerB.claimVerifiedAdvance(first.record.operationId).claimed)
      .toBe(false);
    expect(registry({ filePath, idIndex: 2 }).exportRecords()).toHaveLength(2);
    const files = await readdir(join(filePath, '..'));
    expect(files).toEqual(['cart-mutation-idempotency-v2.json']);
  });

  it('applies TTL and size bounds again during restart restore', async () => {
    const filePath = await persistencePath();
    let now = 100;
    const first = registry({
      filePath,
      maxRecords: 1,
      now: () => now,
      recordTtlMs: 10,
    });
    const expired = first.register({ callId: 'call-a', desired });
    first.register({
      callId: 'call-b',
      desired: { ...desired, targetQuantity: 3 },
    });
    now = 111;

    const restarted = registry({
      filePath,
      idIndex: 2,
      maxRecords: 1,
      now: () => now,
      recordTtlMs: 10,
    });
    expect(restarted.get(expired.record.operationId)).toBeUndefined();
    expect(restarted.exportRecords()).toEqual([]);
  });
});
