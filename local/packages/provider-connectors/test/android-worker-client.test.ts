import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AndroidWorkerClientError, SshAndroidWorkerClient } from '../src/android/worker-client.js';

describe('SSH Android worker client', () => {
  it('sends requests only through stdin over pinned, non-interactive SSH', async () => {
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
    const spawn = (command: string, args: readonly string[]): EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let stdin = '';
      child.stdin.on('data', (chunk) => { stdin += String(chunk); });
      child.stdin.on('finish', () => {
        calls.push({ command, args: [...args], stdin });
        child.stdout.end('{"version":1,"operation":"auth_status","status":"active"}\n');
        child.emit('close', 0);
      });
      return child;
    };
    const client = new SshAndroidWorkerClient({
      host: 'errandos-android-worker.example.ts.net',
      user: 'errandos-worker-agent',
      identityFile: '/run/secrets/android-worker-key',
      knownHostsFile: '/run/secrets/android-worker-known-hosts',
      spawn,
    });
    expect(await client.execute({ version: 1, operation: 'auth_status', accountKey: 'main' })).toMatchObject({ status: 'active' });
    expect(calls[0]?.command).toBe('ssh');
    expect(calls[0]?.args).toEqual([
      '-i', '/run/secrets/android-worker-key',
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=/run/secrets/android-worker-known-hosts',
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      'errandos-worker-agent@errandos-android-worker.example.ts.net',
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('accountKey');
    expect(calls[0]?.stdin).toContain('"accountKey":"main"');
  });

  it('preserves a sanitized typed worker error returned with a nonzero exit', async () => {
    const spawn = (): EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('finish', () => {
        child.stdout.end('{"version":1,"operation":"prepare_existing_checkout","status":"error","stage":"payment_target"}\n');
        child.emit('close', 1);
      });
      return child;
    };
    const client = new SshAndroidWorkerClient({ host: 'worker', user: 'agent', identityFile: 'key', knownHostsFile: 'known-hosts', spawn });

    await expect(client.execute({ version: 1, operation: 'prepare_existing_checkout', accountKey: 'main' }))
      .resolves.toEqual({ version: 1, operation: 'prepare_existing_checkout', status: 'error', stage: 'payment_target' });
  });

  it('classifies an unreachable SSH worker without leaking transport diagnostics', async () => {
    const spawn = (): EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('finish', () => {
        child.stderr.end('ssh: secret-host: authentication failed for /private/key');
        child.emit('close', 255);
      });
      return child;
    };
    const client = new SshAndroidWorkerClient({ host: 'secret-host', user: 'agent', identityFile: '/private/key', knownHostsFile: 'known-hosts', spawn });

    let failure: unknown;
    try { await client.execute({ version: 1, operation: 'auth_status', accountKey: 'main' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AndroidWorkerClientError);
    expect(failure).toMatchObject({ code: 'worker_unreachable' });
    expect(String(failure)).not.toMatch(/secret-host|private\/key|authentication failed/);
  });

  it('terminates a stalled worker operation at its hard deadline', async () => {
    let killed = false;
    const spawn = (): EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal?: NodeJS.Signals): boolean } => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal?: NodeJS.Signals): boolean };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = (signal): boolean => { expect(signal).toBe('SIGTERM'); killed = true; return true; };
      return child;
    };
    const client = new SshAndroidWorkerClient({ host: 'worker', user: 'agent', identityFile: 'key', knownHostsFile: 'known-hosts', operationTimeoutMs: 1_000, spawn });

    await expect(client.execute({ version: 1, operation: 'auth_status', accountKey: 'main' }))
      .rejects.toMatchObject({ code: 'provider_timeout' });
    expect(killed).toBe(true);
  });

  it('serializes independent clients through one account/emulator lease', async () => {
    type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    const children: FakeChild[] = [];
    const spawn = (): FakeChild => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      children.push(child);
      return child;
    };
    const leaseFile = join(await mkdtemp(join(tmpdir(), 'errandos-worker-lease-')), 'worker.lease');
    const options = { host: 'worker', user: 'agent', identityFile: 'key', knownHostsFile: 'known-hosts', leaseFile, operationTimeoutMs: 2_000, spawn };
    const first = new SshAndroidWorkerClient(options).execute({ version: 1, operation: 'auth_status', accountKey: 'main' });
    while (children.length < 1) await delay(5);
    const second = new SshAndroidWorkerClient(options).execute({ version: 1, operation: 'auth_status', accountKey: 'main' });
    await delay(50);
    expect(children).toHaveLength(1);

    children[0]!.stdout.end('{"version":1,"operation":"auth_status","status":"active"}\n'); children[0]!.emit('close', 0);
    await expect(first).resolves.toMatchObject({ status: 'active' });
    while (children.length < 2) await delay(5);
    children[1]!.stdout.end('{"version":1,"operation":"auth_status","status":"active"}\n'); children[1]!.emit('close', 0);
    await expect(second).resolves.toMatchObject({ status: 'active' });
  });
});
