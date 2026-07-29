import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LocalIdentifier } from '../../identifiers';
import type {
  BackgroundPhoneOperationEnqueueInputV2,
  BackgroundPhoneOperationRecordV2,
  BackgroundPhoneOperationTerminalStatusV2,
} from './contracts';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
  type BackgroundPhoneOperationEnqueueResultV2,
  type BackgroundPhoneOperationStoreV2,
} from './store';

export class FileBackedBackgroundPhoneOperationStoreV2
implements BackgroundPhoneOperationStoreV2 {
  private readonly memory: InMemoryBackgroundPhoneOperationStoreV2;
  private readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    maxOperations = 128,
  ) {
    this.memory = new InMemoryBackgroundPhoneOperationStoreV2(maxOperations);
    this.ready = this.restoreFromDisk();
  }

  async claim(
    operationId: LocalIdentifier<'operation'>,
    startedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined> {
    return this.mutate(
      () => this.memory.claim(operationId, startedAt),
      (result) => result !== undefined,
    );
  }

  async complete(input: {
    operationId: LocalIdentifier<'operation'>;
    outcome: BackgroundPhoneOperationTerminalStatusV2;
    terminalAt: number;
    detail?: string;
    resultRef?: string;
  }): Promise<BackgroundPhoneOperationRecordV2> {
    return this.mutate(() => this.memory.complete(input), () => true);
  }

  async enqueue(input: {
    operationId: LocalIdentifier<'operation'>;
    acceptedAt: number;
    request: BackgroundPhoneOperationEnqueueInputV2;
  }): Promise<BackgroundPhoneOperationEnqueueResultV2> {
    return this.mutate(
      () => this.memory.enqueue(input),
      (result) => result.disposition === 'enqueued',
    );
  }

  async exportSnapshot(): Promise<string> {
    await this.ready;
    await this.mutationTail;
    return this.memory.exportSnapshot();
  }

  async get(
    operationId: LocalIdentifier<'operation'>,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined> {
    await this.ready;
    await this.mutationTail;
    return this.memory.get(operationId);
  }

  async listTerminalOperations():
  Promise<BackgroundPhoneOperationRecordV2[]> {
    await this.ready;
    await this.mutationTail;
    return this.memory.listTerminalOperations();
  }

  async listQueued(
    taskId?: LocalIdentifier<'task'>,
  ): Promise<BackgroundPhoneOperationRecordV2[]> {
    await this.ready;
    await this.mutationTail;
    return this.memory.listQueued(taskId);
  }

  async markTerminalEventPublished(
    operationId: LocalIdentifier<'operation'>,
    publishedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2> {
    return this.mutate(
      () => this.memory.markTerminalEventPublished(operationId, publishedAt),
      (result) => result.terminalEventPublishedAt === publishedAt,
    );
  }

  async markMutationAttempted(
    operationId: LocalIdentifier<'operation'>,
    attemptedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2> {
    return this.mutate(
      () => this.memory.markMutationAttempted(operationId, attemptedAt),
      (result) => result.status === 'mutation_attempted',
    );
  }

  async recoverInterrupted(recoveredAt: number): Promise<number> {
    return this.mutate(
      () => this.memory.recoverInterrupted(recoveredAt),
      (recovered) => recovered > 0,
    );
  }

  async restoreSnapshot(serialized: string): Promise<{ restored: number }> {
    return this.mutate(
      () => this.memory.restoreSnapshot(serialized),
      () => true,
    );
  }

  private async mutate<T>(
    operation: () => Promise<T>,
    changed: (result: T) => boolean,
  ): Promise<T> {
    await this.ready;
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = await this.memory.exportSnapshot();
    try {
      const result = await operation();
      if (changed(result)) await this.persist();
      return result;
    } catch (error) {
      await this.memory.restoreSnapshot(before);
      throw error;
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        await this.memory.exportSnapshot(),
        {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        },
      );
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async restoreFromDisk(): Promise<void> {
    try {
      await this.memory.restoreSnapshot(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }
}
