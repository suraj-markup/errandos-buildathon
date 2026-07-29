import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { OperationIdempotencyRecordV2 } from './contracts';

export type OperationIdempotencyPersistenceStateV2 = {
  generation: number;
  records: readonly OperationIdempotencyRecordV2[];
};

export type OperationIdempotencyPersistenceTransactionV2<T> = {
  records: readonly OperationIdempotencyRecordV2[];
  result: T;
};

export interface OperationIdempotencyPersistenceV2 {
  transact<T>(
    update: (
      state: OperationIdempotencyPersistenceStateV2,
    ) => OperationIdempotencyPersistenceTransactionV2<T>,
  ): T;
}

type PersistenceDocumentV2 = {
  schemaVersion: 2;
  generation: number;
  savedAt: number;
  records: readonly OperationIdempotencyRecordV2[];
};

type PersistenceEnvelopeV2 = {
  checksum: string;
  document: PersistenceDocumentV2;
};

type FilePersistenceOptionsV2 = {
  lockRetryMs?: number;
  lockStaleMs?: number;
  lockTimeoutMs?: number;
  maxFileBytes?: number;
  now?: () => number;
};

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function checksum(document: PersistenceDocumentV2): string {
  return createHash('sha256')
    .update(JSON.stringify(document))
    .digest('hex');
}

function emptyDocument(now: number): PersistenceDocumentV2 {
  return {
    schemaVersion: 2,
    generation: 0,
    savedAt: now,
    records: [],
  };
}

function parsedDocument(
  serialized: string,
  now: number,
): PersistenceDocumentV2 {
  try {
    const envelope = JSON.parse(serialized) as Partial<PersistenceEnvelopeV2>;
    const document = envelope.document as Partial<PersistenceDocumentV2>;
    if (
      !document
      || document.schemaVersion !== 2
      || !Number.isSafeInteger(document.generation)
      || document.generation! < 0
      || !Number.isSafeInteger(document.savedAt)
      || document.savedAt! < 0
      || !Array.isArray(document.records)
      || typeof envelope.checksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(envelope.checksum)
      || checksum(document as PersistenceDocumentV2) !== envelope.checksum
    ) {
      return emptyDocument(now);
    }
    return document as PersistenceDocumentV2;
  } catch {
    return emptyDocument(now);
  }
}

function isAlreadyMissing(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export class FileOperationIdempotencyPersistenceV2
implements OperationIdempotencyPersistenceV2 {
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  private readonly lockTimeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;

  constructor(
    readonly filePath: string,
    options: FilePersistenceOptionsV2 = {},
  ) {
    if (!filePath.trim()) throw new Error('Persistence path is required.');
    this.lockRetryMs = positiveInteger(
      options.lockRetryMs ?? 10,
      'lockRetryMs',
    );
    this.lockStaleMs = positiveInteger(
      options.lockStaleMs ?? 30_000,
      'lockStaleMs',
    );
    this.lockTimeoutMs = positiveInteger(
      options.lockTimeoutMs ?? 5_000,
      'lockTimeoutMs',
    );
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes ?? 8 * 1_024 * 1_024,
      'maxFileBytes',
    );
    this.now = options.now ?? Date.now;
  }

  transact<T>(
    update: (
      state: OperationIdempotencyPersistenceStateV2,
    ) => OperationIdempotencyPersistenceTransactionV2<T>,
  ): T {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const release = this.acquireLock();
    try {
      const current = this.readDocument();
      const transaction = update({
        generation: current.generation,
        records: structuredClone(current.records),
      });
      const next: PersistenceDocumentV2 = {
        schemaVersion: 2,
        generation: current.generation + 1,
        savedAt: this.now(),
        records: structuredClone(transaction.records),
      };
      this.writeDocument(next);
      return transaction.result;
    } finally {
      release();
    }
  }

  private acquireLock(): () => void {
    const lockPath = `${this.filePath}.lock`;
    const startedAt = this.now();
    while (true) {
      try {
        const descriptor = openSync(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          writeFileSync(
            descriptor,
            JSON.stringify({ pid: process.pid, acquiredAt: this.now() }),
            'utf8',
          );
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        return () => {
          try {
            unlinkSync(lockPath);
          } catch (error) {
            if (!isAlreadyMissing(error)) throw error;
          }
        };
      } catch (error) {
        const code = error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code !== 'EEXIST') throw error;
        try {
          if (this.now() - statSync(lockPath).mtimeMs >= this.lockStaleMs) {
            unlinkSync(lockPath);
            continue;
          }
        } catch (statError) {
          if (isAlreadyMissing(statError)) continue;
          throw statError;
        }
        if (this.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error('Timed out acquiring idempotency persistence lock.');
        }
        Atomics.wait(sleepBuffer, 0, 0, this.lockRetryMs);
      }
    }
  }

  private readDocument(): PersistenceDocumentV2 {
    try {
      if (statSync(this.filePath).size > this.maxFileBytes) {
        return emptyDocument(this.now());
      }
      return parsedDocument(readFileSync(this.filePath, 'utf8'), this.now());
    } catch (error) {
      if (isAlreadyMissing(error)) return emptyDocument(this.now());
      return emptyDocument(this.now());
    }
  }

  private writeDocument(document: PersistenceDocumentV2): void {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify({
      checksum: checksum(document),
      document,
    } satisfies PersistenceEnvelopeV2);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) {
      throw new Error('Idempotency persistence exceeds its size bound.');
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
      const directoryDescriptor = openSync(dirname(this.filePath), 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isAlreadyMissing(error)) throw error;
      }
    }
  }
}
