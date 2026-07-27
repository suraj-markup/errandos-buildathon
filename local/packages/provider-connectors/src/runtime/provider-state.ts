import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PrincipalId } from '@errandos/contracts';

export interface DurableProviderState {
  put(owner: PrincipalId, value: unknown): Promise<string>;
  get(owner: PrincipalId, reference: string): Promise<unknown>;
  replace(owner: PrincipalId, reference: string, value: unknown): Promise<void>;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class FileProviderState implements DurableProviderState {
  private readonly root: string;

  public constructor(root: string) { this.root = resolve(root); }

  public async put(owner: PrincipalId, value: unknown): Promise<string> {
    const reference = `state_${randomUUID()}`;
    const path = this.path(reference);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify({ owner, value }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return reference;
  }

  public async get(owner: PrincipalId, reference: string): Promise<unknown> {
    if (!/^state_[0-9a-f-]{36}$/.test(reference)) throw new Error('provider state not found');
    try {
      const record = JSON.parse(await readFile(this.path(reference), 'utf8')) as { owner: PrincipalId; value: unknown };
      if (record.owner !== owner) throw new Error('provider state not found');
      return record.value;
    } catch { throw new Error('provider state not found'); }
  }

  public async replace(owner: PrincipalId, reference: string, value: unknown): Promise<void> {
    await this.get(owner, reference);
    const path = this.path(reference);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ owner, value }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  private path(reference: string): string { return join(this.root, `${hash(reference)}.json`); }
}
