import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  CheckoutRecordRevisionConflictV2,
  type CheckoutOrchestrationRecordV2,
  type CheckoutOrchestrationRepositoryV2,
} from './orchestration-service';
import type { LocalIdentifier } from '../../workflow/identifiers';

type CheckoutRecordEnvelopeV2 = {
  version: 2;
  checksum: string;
  record: CheckoutOrchestrationRecordV2;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

function identifier(value: string, name: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function checksum(record: CheckoutOrchestrationRecordV2): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function serialize(record: CheckoutOrchestrationRecordV2): string {
  return `${JSON.stringify({
    version: 2,
    checksum: checksum(record),
    record,
  } satisfies CheckoutRecordEnvelopeV2)}\n`;
}

function parse(serialized: string): CheckoutOrchestrationRecordV2 {
  const envelope = JSON.parse(serialized) as Partial<CheckoutRecordEnvelopeV2>;
  if (
    envelope.version !== 2
    || !envelope.record
    || typeof envelope.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(envelope.checksum)
    || checksum(envelope.record) !== envelope.checksum
  ) {
    throw new Error('Invalid checkout orchestration record checksum.');
  }
  const record = envelope.record;
  if (
    record.version !== 2
    || !identifierPattern.test(record.checkoutId)
    || !identifierPattern.test(record.clientId)
    || !identifierPattern.test(record.ownerId)
    || !Number.isSafeInteger(record.recordRevision)
    || record.recordRevision < 0
    || !Number.isSafeInteger(record.taskRevision)
    || record.taskRevision < 0
    || record.graph.version !== 2
    || record.graph.taskId !== record.taskId
    || record.graph.taskRevision !== record.taskRevision
    || !Array.isArray(record.events)
    || record.events.some((event) =>
      !Number.isSafeInteger(event.recordRevision)
      || event.recordRevision < 0
      || event.recordRevision > record.recordRevision)
  ) {
    throw new Error('Invalid checkout orchestration record.');
  }
  return structuredClone(record);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export class FileCheckoutOrchestrationRepositoryV2
  implements CheckoutOrchestrationRepositoryV2 {
  private readonly queues = new Map<string, Promise<void>>();
  private static readonly maxDiscoverableRecords = 256;

  constructor(private readonly root: string) {}

  async create(
    record: CheckoutOrchestrationRecordV2,
  ): Promise<CheckoutOrchestrationRecordV2> {
    return this.exclusive(record.checkoutId, async () => {
      await this.ensureRoot();
      try {
        await writeFile(
          this.path(record.checkoutId),
          serialize(record),
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && (error as { code?: unknown }).code === 'EEXIST'
        ) {
          throw new Error(`Checkout ${record.checkoutId} already exists.`);
        }
        throw error;
      }
      return structuredClone(record);
    });
  }

  async get(
    checkoutId: string,
  ): Promise<CheckoutOrchestrationRecordV2 | undefined> {
    try {
      return parse(await readFile(this.path(checkoutId), 'utf8'));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async findLatest(input: {
    clientId: string;
    ownerId: string;
    taskId?: LocalIdentifier<'task'>;
  }): Promise<CheckoutOrchestrationRecordV2 | undefined> {
    let names: string[];
    try {
      names = (await readdir(this.root))
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (names.length > FileCheckoutOrchestrationRepositoryV2.maxDiscoverableRecords) {
      throw new Error('Checkout discovery capacity reached.');
    }
    const records = await Promise.all(names.map((name) =>
      readFile(join(this.root, name), 'utf8').then(parse)));
    const match = records
      .filter((record) =>
        record.clientId === input.clientId
        && record.ownerId === input.ownerId
        && (!input.taskId || record.taskId === input.taskId))
      .sort((left, right) =>
        right.updatedAt - left.updatedAt
        || right.recordRevision - left.recordRevision
        || right.checkoutId.localeCompare(left.checkoutId))[0];
    return match ? structuredClone(match) : undefined;
  }

  async save(
    record: CheckoutOrchestrationRecordV2,
    expectedRevision: number,
  ): Promise<CheckoutOrchestrationRecordV2> {
    return this.exclusive(record.checkoutId, async () => {
      const current = await this.get(record.checkoutId);
      if (!current) {
        throw new Error(`Checkout ${record.checkoutId} was not found.`);
      }
      if (current.recordRevision !== expectedRevision) {
        throw new CheckoutRecordRevisionConflictV2(
          record.checkoutId,
          expectedRevision,
          current.recordRevision,
        );
      }
      if (record.recordRevision !== expectedRevision + 1) {
        throw new Error(
          'Checkout save must advance exactly one record revision.',
        );
      }
      await this.ensureRoot();
      const temporary = join(
        this.root,
        `.${record.checkoutId}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(
          temporary,
          serialize(record),
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        await rename(temporary, this.path(record.checkoutId));
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return structuredClone(record);
    });
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  private path(checkoutId: string): string {
    return join(
      this.root,
      `${identifier(checkoutId, 'checkoutId')}.json`,
    );
  }

  private async exclusive<T>(
    checkoutId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = identifier(checkoutId, 'checkoutId');
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}
