import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  InMemoryPhoneTaskRepositoryV2,
  type PhoneTaskRepositoryV2,
  type TaskRecoveryOperationV2,
  type TaskReplacementReasonV2,
  type TaskRepositoryEventV2,
  type TaskRepositoryRecordV2,
} from './repository';
import type { PhoneTaskV2 } from './contracts';

export class FileBackedPhoneTaskRepositoryV2
implements PhoneTaskRepositoryV2 {
  private readonly memory: InMemoryPhoneTaskRepositoryV2;
  private readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: ConstructorParameters<typeof InMemoryPhoneTaskRepositoryV2>[0] = {},
  ) {
    this.memory = new InMemoryPhoneTaskRepositoryV2(options);
    this.ready = this.restoreFromDisk();
  }

  async cleanupExpired(): Promise<number> {
    return this.mutate(async () => {
      const removed = await this.memory.cleanupExpired();
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  async commit(input: {
    expectedRevision: number;
    task: PhoneTaskV2;
    event: TaskRepositoryEventV2;
    activeOperation?: TaskRecoveryOperationV2;
  }): Promise<TaskRepositoryRecordV2> {
    return this.mutate(async () => {
      const record = await this.memory.commit(input);
      await this.persist();
      return record;
    });
  }

  async create(input: {
    task: PhoneTaskV2;
    event: TaskRepositoryEventV2;
    activeOperation?: TaskRecoveryOperationV2;
  }): Promise<TaskRepositoryRecordV2> {
    return this.mutate(async () => {
      const record = await this.memory.create(input);
      await this.persist();
      return record;
    });
  }

  async delete(taskId: string): Promise<boolean> {
    return this.mutate(async () => {
      const removed = await this.memory.delete(taskId);
      if (removed) await this.persist();
      return removed;
    });
  }

  async exportSnapshot(): Promise<string> {
    await this.ready;
    return this.memory.exportSnapshot();
  }

  async getByClientId(
    clientId: string,
  ): Promise<TaskRepositoryRecordV2 | undefined> {
    await this.ready;
    return this.memory.getByClientId(clientId);
  }

  async getById(
    taskId: string,
  ): Promise<TaskRepositoryRecordV2 | undefined> {
    await this.ready;
    return this.memory.getById(taskId);
  }

  async list(): Promise<TaskRepositoryRecordV2[]> {
    await this.ready;
    return this.memory.list();
  }

  async replaceForClient(input: {
    currentTaskId: string;
    expectedRevision: number;
    nextTask: PhoneTaskV2;
    reason: TaskReplacementReasonV2;
    replacedEvent: TaskRepositoryEventV2;
    createdEvent: TaskRepositoryEventV2;
  }): Promise<{
    replaced: TaskRepositoryRecordV2;
    created: TaskRepositoryRecordV2;
  }> {
    return this.mutate(async () => {
      const result = await this.memory.replaceForClient(input);
      await this.persist();
      return result;
    });
  }

  async restoreSnapshot(serialized: string): Promise<{
    discarded: number;
    restored: number;
  }> {
    return this.mutate(async () => {
      const result = await this.memory.restoreSnapshot(serialized);
      await this.persist();
      return result;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready;
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
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
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
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
    try {
      await this.memory.restoreSnapshot(serialized);
    } catch {
      // Keep corrupt evidence for diagnosis. The repository fails closed as
      // empty rather than deleting or partially restoring it.
    }
  }
}
