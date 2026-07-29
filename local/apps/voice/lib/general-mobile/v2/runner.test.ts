import { describe, expect, it, vi } from 'vitest';
import { runBoundedGeneralMobilePlanV2 } from './runner';
import {
  actionFor,
  observeSafe,
  testSystem,
} from './test-helpers';

describe('bounded general-mobile replanning runner', () => {
  it('replans once around an unexpected dialog without external side effects', async () => {
    const { adapter, companion, registry } = testSystem();
    const home = await observeSafe(companion, 'Open editor');
    adapter.queueUnexpectedDialog();
    const requested = actionFor({
      actionId: 'action:open-editor',
      capability: 'activate',
      observation: home.observation,
      targetRef: home.pointTarget!.elementRef,
    });
    const dismiss = actionFor({
      actionId: 'action:dismiss-dialog',
      capability: 'back',
    });
    const replan = vi.fn().mockResolvedValue([dismiss]);

    const result = await runBoundedGeneralMobilePlanV2({
      registry,
      actions: [requested],
      currentTaskRevision: 1,
      observationFor: (action) =>
        action.sourceObservationId ? home.observation : undefined,
      replan,
      maxReplans: 2,
    });

    expect(result).toMatchObject({
      status: 'verified',
      attempts: 2,
      replans: 1,
    });
    expect(result.results.map((entry) => entry.status))
      .toEqual(['unexpected_dialog', 'verified']);
    expect(replan).toHaveBeenCalledOnce();
    expect(adapter.state().screen).toBe('home');
  });

  it('stops after the bounded number of no-progress replans', async () => {
    const { adapter, registry } = testSystem();
    adapter.setNoProgress(10);
    let sequence = 0;
    const replan = vi.fn().mockImplementation(async () => [
      actionFor({
        actionId: `action:retry-${++sequence}`,
        capability: 'back',
      }),
    ]);

    const result = await runBoundedGeneralMobilePlanV2({
      registry,
      actions: [actionFor({
        actionId: 'action:initial',
        capability: 'back',
      })],
      currentTaskRevision: 1,
      observationFor: () => undefined,
      replan,
      maxReplans: 2,
      maxActions: 5,
    });

    expect(result).toMatchObject({
      status: 'replan_exhausted',
      attempts: 3,
      replans: 2,
    });
    expect(result.results.map((entry) => entry.status))
      .toEqual(['no_progress', 'no_progress', 'no_progress']);
  });

  it('honors cancellation before any adapter action', async () => {
    const { adapter, registry } = testSystem();
    const result = await runBoundedGeneralMobilePlanV2({
      registry,
      actions: [actionFor({
        actionId: 'action:never-run',
        capability: 'back',
      })],
      currentTaskRevision: 1,
      observationFor: () => undefined,
      replan: async () => [],
      isCancelled: () => true,
    });

    expect(result).toEqual({
      status: 'cancelled',
      attempts: 0,
      replans: 0,
      results: [],
    });
    expect(adapter.actionLog).toHaveLength(0);
  });
});
