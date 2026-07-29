import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBackedPhoneTaskRepositoryV2 } from './file-repository';
import { validTaskV2 } from './test-fixtures';

const directories: string[] = [];

async function repositoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jaldi-v2-repository-'));
  directories.push(directory);
  return join(directory, 'phone-task-v2.json');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe('file-backed PhoneTaskV2 repository', () => {
  it('atomically restores task state after a server restart', async () => {
    const path = await repositoryPath();
    const task = validTaskV2();
    const first = new FileBackedPhoneTaskRepositoryV2(path, {
      now: () => 10,
    });
    await first.create({
      task,
      event: {
        eventId: 'event:file-created',
        taskId: task.taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_created',
      },
    });

    const restarted = new FileBackedPhoneTaskRepositoryV2(path, {
      now: () => 11,
    });
    await expect(restarted.getByClientId(task.clientId)).resolves
      .toMatchObject({
        task: {
          originalGoal: task.originalGoal,
          revision: task.revision,
          taskId: task.taskId,
        },
      });
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(2);
  });

  it('fails closed without deleting a corrupt restart snapshot', async () => {
    const path = await repositoryPath();
    await writeFile(path, '{"schemaVersion":2,"records":"corrupt"}', 'utf8');

    const restarted = new FileBackedPhoneTaskRepositoryV2(path);

    await expect(restarted.list()).resolves.toEqual([]);
    await expect(readFile(path, 'utf8')).resolves
      .toContain('"records":"corrupt"');
  });
});
