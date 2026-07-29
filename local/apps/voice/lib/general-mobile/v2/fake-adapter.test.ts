import { describe, expect, it } from 'vitest';
import {
  actionFor,
  observeSafe,
  testSystem,
} from './test-helpers';

describe('instrumented general-mobile fake adapter', () => {
  it('covers semantic navigation and a verified local edit', async () => {
    const { adapter, companion, registry } = testSystem();
    const home = await observeSafe(companion, 'Open editor');
    const navigation = actionFor({
      actionId: 'action:open-editor',
      capability: 'activate',
      observation: home.observation,
      targetRef: home.pointTarget!.elementRef,
    });
    await expect(registry.execute({
      action: navigation,
      observation: home.observation,
      currentTaskRevision: 1,
    })).resolves.toEqual({
      status: 'verified',
      resultRef: 'fake:navigated_to_editor',
    });

    const editor = await observeSafe(companion, 'Draft text');
    const edit = actionFor({
      actionId: 'action:set-draft',
      capability: 'set_text',
      observation: editor.observation,
      targetRef: editor.pointTarget!.elementRef,
      payload: { text: 'A local draft only' },
      idempotencyKey: 'desired:draft-v1',
    });
    await expect(registry.execute({
      action: edit,
      observation: editor.observation,
      currentTaskRevision: 1,
    })).resolves.toEqual({
      status: 'verified',
      resultRef: 'fake:local_edit_verified',
    });
    expect(adapter.state()).toMatchObject({
      screen: 'editor',
      draft: 'A local draft only',
    });
  });

  it('reports an unexpected dialog before changing the requested target', async () => {
    const { adapter, companion, registry } = testSystem();
    const home = await observeSafe(companion, 'Open editor');
    adapter.queueUnexpectedDialog();
    const result = await registry.execute({
      action: actionFor({
        actionId: 'action:dialog-interrupted',
        capability: 'activate',
        observation: home.observation,
        targetRef: home.pointTarget!.elementRef,
      }),
      observation: home.observation,
      currentTaskRevision: 1,
    });

    expect(result).toEqual({
      status: 'unexpected_dialog',
      reasonRef: 'fake:unexpected_dialog',
    });
    expect(adapter.state().screen).toBe('dialog');
  });

  it('reports stale targets after the screen fingerprint changes', async () => {
    const { companion, registry } = testSystem();
    const home = await observeSafe(companion, 'Open editor');
    const action = actionFor({
      actionId: 'action:open-once',
      capability: 'activate',
      observation: home.observation,
      targetRef: home.pointTarget!.elementRef,
    });
    await registry.execute({
      action,
      observation: home.observation,
      currentTaskRevision: 1,
    });

    const stale = await registry.execute({
      action: actionFor({
        actionId: 'action:open-stale',
        capability: 'activate',
        observation: home.observation,
        targetRef: home.pointTarget!.elementRef,
      }),
      observation: home.observation,
      currentTaskRevision: 1,
    });
    expect(stale).toEqual({
      status: 'stale_target',
      reasonRef: 'fake:stale_semantic_target',
    });
  });

  it('reports no progress and cancellation without mutating local state', async () => {
    const { adapter, registry } = testSystem();
    adapter.setNoProgress(1);
    const back = actionFor({
      actionId: 'action:no-progress',
      capability: 'back',
    });
    expect(await registry.execute({
      action: back,
      currentTaskRevision: 1,
    })).toEqual({
      status: 'no_progress',
      reasonRef: 'fake:fingerprint_unchanged',
    });
    const before = adapter.state();
    expect(await registry.execute({
      action: actionFor({
        actionId: 'action:cancelled',
        capability: 'back',
      }),
      currentTaskRevision: 1,
      isCancelled: () => true,
    })).toEqual({
      status: 'cancelled',
      reasonRef: 'fake:cancelled_before_action',
    });
    expect(adapter.state()).toEqual(before);
  });
});
