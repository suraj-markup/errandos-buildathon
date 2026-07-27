import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AndroidWorkerRequestSchemaV1,
  AndroidWorkerResponseSchemaV1,
  RapidoAndroidWorkerRequestSchemaV1,
  RapidoAndroidWorkerResponseSchemaV1,
  type AndroidWorkerRequestV1,
  type AndroidWorkerResponseV1,
  type RapidoAndroidWorkerRequestV1,
  type RapidoAndroidWorkerResponseV1,
} from '@errandos/contracts';

interface ChildPort {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null) => void): this;
  kill?(signal?: NodeJS.Signals): boolean;
}

export type SpawnPort = (command: string, args: readonly string[]) => ChildPort;

export interface SshAndroidWorkerClientOptions {
  host: string;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  leaseFile?: string;
  operationTimeoutMs?: number;
  spawn?: SpawnPort;
}

export interface AndroidWorkerPort {
  execute(request: AndroidWorkerRequestV1): Promise<AndroidWorkerResponseV1>;
}

export interface RapidoAndroidWorkerPort {
  executeRapido(request: RapidoAndroidWorkerRequestV1): Promise<RapidoAndroidWorkerResponseV1>;
}

export type AndroidWorkerClientFailureCode =
  | 'worker_unreachable'
  | 'worker_execution_failed'
  | 'worker_response_invalid'
  | 'provider_timeout';

export class AndroidWorkerClientError extends Error {
  public constructor(public readonly code: AndroidWorkerClientFailureCode) {
    super(`Android worker failed: ${code}`);
    this.name = 'AndroidWorkerClientError';
  }
}

export class AndroidWorkerOperationError extends Error {
  public readonly stage: string;
  public readonly details?: { itemSubtotal: number; requiredSubtotal: number };

  public constructor(stage: string, details?: { itemSubtotal: number; requiredSubtotal: number }) {
    const safeStage = /^[a-z][a-z0-9_]{1,63}$/.test(stage) ? stage : 'operation_failed';
    super(`Android worker operation failed: ${safeStage}`);
    this.name = 'AndroidWorkerOperationError';
    this.stage = safeStage;
    if (
      safeStage === 'cod_minimum_not_met'
      && details
      && Number.isFinite(details.itemSubtotal)
      && Number.isFinite(details.requiredSubtotal)
      && details.itemSubtotal >= 0
      && details.requiredSubtotal > details.itemSubtotal
    ) {
      this.details = {
        itemSubtotal: details.itemSubtotal,
        requiredSubtotal: details.requiredSubtotal,
      };
    }
  }
}

export class SshAndroidWorkerClient implements AndroidWorkerPort {
  private readonly spawn: SpawnPort;
  private readonly operationTimeoutMs: number;

  public constructor(private readonly options: SshAndroidWorkerClientOptions) {
    this.spawn = options.spawn ?? ((command, args): ChildPort => nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
    this.operationTimeoutMs = options.operationTimeoutMs ?? 120_000;
    if (!Number.isInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1_000) throw new Error('operationTimeoutMs must be an integer of at least 1000');
  }

  public async execute(request: AndroidWorkerRequestV1): Promise<AndroidWorkerResponseV1> {
    const validated = AndroidWorkerRequestSchemaV1.parse(request);
    if (!this.options.leaseFile) return this.executeValidated(validated);
    const release = await acquireLease(this.options.leaseFile, this.operationTimeoutMs);
    try { return await this.executeValidated(validated); } finally { await release(); }
  }

  public async executeRapido(request: RapidoAndroidWorkerRequestV1): Promise<RapidoAndroidWorkerResponseV1> {
    const validated = RapidoAndroidWorkerRequestSchemaV1.parse(request);
    const run = async (): Promise<RapidoAndroidWorkerResponseV1> => this.executePayload(
      validated,
      (value) => RapidoAndroidWorkerResponseSchemaV1.parse(value),
    );
    if (!this.options.leaseFile) return run();
    const release = await acquireLease(this.options.leaseFile, this.operationTimeoutMs);
    try { return await run(); } finally { await release(); }
  }

  private async executeValidated(validated: AndroidWorkerRequestV1): Promise<AndroidWorkerResponseV1> {
    return this.executePayload(validated, (value) => AndroidWorkerResponseSchemaV1.parse(value));
  }

  private async executePayload<T>(
    validated: AndroidWorkerRequestV1 | RapidoAndroidWorkerRequestV1,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const args = [
      '-i', this.options.identityFile,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${this.options.knownHostsFile}`,
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      `${this.options.user}@${this.options.host}`,
    ];
    const child = this.spawn('ssh', args);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > 65_536) child.stdout.destroy(new Error('worker response too large'));
    });
    child.stderr.resume();

    const code = await new Promise<number | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: number | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const fail = (error: AndroidWorkerClientError): void => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { child.kill?.('SIGTERM'); fail(new AndroidWorkerClientError('provider_timeout')); }, this.operationTimeoutMs);
      child.once('error', () => fail(new AndroidWorkerClientError('worker_unreachable')));
      child.once('close', finish);
      child.stdin.end(`${JSON.stringify(validated)}\n`);
    });
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length !== 1 || !lines[0]) throw workerFailure(code);
    try {
      return parse(JSON.parse(lines[0]!));
    } catch {
      throw workerFailure(code);
    }
  }
}

async function acquireLease(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return async (): Promise<void> => { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await leaseIsOrphaned(path, timeoutMs)) { await unlink(path).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new AndroidWorkerClientError('provider_timeout');
      await delay(100);
    }
  }
}

async function leaseIsOrphaned(path: string, timeoutMs: number): Promise<boolean> {
  try {
    const [value, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    if (Date.now() - metadata.mtimeMs > timeoutMs + 10_000) return true;
    const pid = (JSON.parse(value) as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function workerFailure(code: number | null): AndroidWorkerClientError {
  if (code === 255 || code === null) return new AndroidWorkerClientError('worker_unreachable');
  return new AndroidWorkerClientError(code === 0 ? 'worker_response_invalid' : 'worker_execution_failed');
}
