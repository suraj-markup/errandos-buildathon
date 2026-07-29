import { describe, expect, it, vi } from 'vitest';
import {
  executeSequentialProductQueue,
  type SequentialProductAction,
} from './product-workflow';

const add = (request: string): SequentialProductAction => ({
  action: 'add_cart_item',
  quantity: 1,
  request,
});

describe('sequential product workflow', () => {
  it('stops after the first product asks for a choice', async () => {
    const execute = vi.fn(async () => ({ status: 'needs_clarification' }));
    const actions = Array.from({ length: 10 }, (_, index) => add(`product ${index + 1}`));

    const result = await executeSequentialProductQueue(actions, execute);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.blockedAction?.request).toBe('product 1');
    expect(result.remainingActions.map((action) => action.request))
      .toEqual(actions.slice(1).map((action) => action.request));
  });

  it('moves to the next product only after the current one completes', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 'added' })
      .mockResolvedValueOnce({ status: 'needs_clarification' });

    const result = await executeSequentialProductQueue(
      [add('milk'), add('bread'), add('eggs')],
      execute,
    );

    expect(execute.mock.calls.map(([action]) => action.request))
      .toEqual(['milk', 'bread']);
    expect(result.blockedAction?.request).toBe('bread');
    expect(result.remainingActions.map((action) => action.request))
      .toEqual(['eggs']);
  });

  it('continues through products that require no follow-up', async () => {
    const execute = vi.fn(async () => ({ status: 'added' }));

    const result = await executeSequentialProductQueue(
      [add('milk'), add('bread')],
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.remainingActions).toEqual([]);
    expect(result.blockedAction).toBeUndefined();
  });

  it('emits each result checkpoint before starting the next action', async () => {
    const timeline: string[] = [];
    const actions = [add('milk'), add('bread')];

    await executeSequentialProductQueue(
      actions,
      async (action) => {
        timeline.push(`execute:${action.request}`);
        return { status: 'added' };
      },
      {
        onResult: ({ action, nextAction }) => {
          timeline.push(
            `result:${action.request}:next=${nextAction?.request ?? 'none'}`,
          );
        },
      },
    );

    expect(timeline).toEqual([
      'execute:milk',
      'result:milk:next=bread',
      'execute:bread',
      'result:bread:next=none',
    ]);
  });

  it('keeps later products unsearched and the current item retryable after execution failure', async () => {
    const execute = vi.fn(async () => ({ status: 'execution_failed' }));

    const result = await executeSequentialProductQueue(
      [add('milk'), add('bread')],
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.blockedAction?.request).toBe('milk');
    expect(result.remainingActions.map((action) => action.request))
      .toEqual(['bread']);
  });

  it.each([
    'mutation_outcome_ambiguous',
    'reconciliation_required',
    'retry_allowed',
  ])('does not execute a later product after %s', async (status) => {
    const actions = [add('milk'), add('ice cream')];
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, status })
      .mockResolvedValueOnce({ ok: true, status: 'added' });

    const result = await executeSequentialProductQueue(actions, execute);

    expect(execute).toHaveBeenCalledOnce();
    expect(result.blockedAction).toEqual(actions[0]);
    expect(result.remainingActions).toEqual([actions[1]]);
    expect(result.results).toEqual([{ ok: false, status }]);
  });
});
