import { describe, expect, it } from 'vitest';
import {
  BoundedResponseHistoryStore,
  isStartOverRequest,
} from './bounded-history';

describe('bounded response-chain history', () => {
  it('truncates deterministically by turn count without touching task state', () => {
    let now = 100;
    const history = new BoundedResponseHistoryStore({
      maxResponseChainLength: 20,
      maxTurns: 2,
      now: () => now,
    });
    const task = {
      items: ['milk', 'bread', 'ice cream'],
      phase: 'awaiting_product_choice',
      selectedOffer: { offerId: 'offer_opaque' },
    };

    history.beginTurn({ clientId: 'pixel-overlay', turnId: 'request-one' });
    history.completeTurn({
      clientId: 'pixel-overlay',
      responseCount: 1,
      responseId: 'resp_12345678',
      turnId: 'request-one',
    });
    now += 1;
    expect(history.beginTurn({
      clientId: 'pixel-overlay',
      turnId: 'request-two',
    }).previousResponseId).toBe('resp_12345678');
    history.completeTurn({
      clientId: 'pixel-overlay',
      responseCount: 1,
      responseId: 'resp_87654321',
      turnId: 'request-two',
    });
    now += 1;
    expect(history.beginTurn({
      clientId: 'pixel-overlay',
      turnId: 'request-three',
    })).toMatchObject({
      resetReason: 'max_turns',
      responseCount: 0,
      turnCount: 1,
    });

    expect(task).toEqual({
      items: ['milk', 'bread', 'ice cream'],
      phase: 'awaiting_product_choice',
      selectedOffer: { offerId: 'offer_opaque' },
    });
  });

  it('reserves capacity for deterministic same-turn response follow-ups', () => {
    const history = new BoundedResponseHistoryStore({
      maxResponseChainLength: 3,
      maxTurns: 20,
    });
    history.beginTurn({
      clientId: 'pixel-overlay',
      expectedResponses: 2,
      turnId: 'request-one',
    });
    history.completeTurn({
      clientId: 'pixel-overlay',
      responseCount: 2,
      responseId: 'resp_12345678',
      turnId: 'request-one',
    });

    expect(history.beginTurn({
      clientId: 'pixel-overlay',
      expectedResponses: 2,
      turnId: 'request-two',
    })).toMatchObject({
      resetReason: 'max_response_chain',
      responseCount: 0,
      turnCount: 1,
    });
  });

  it.each([
    {
      name: 'pending clarification',
      state: { clarificationId: 'clarification_safe', phase: 'awaiting_choice' },
    },
    {
      name: 'selected offer',
      state: { offerId: 'offer_safe', phase: 'selected' },
    },
    {
      name: 'pending checkout',
      state: { checkoutFingerprint: 'opaque', phase: 'awaiting_checkout' },
    },
    {
      name: 'new Realtime session',
      state: { realtimeSessionId: 'realtime_safe', phase: 'ready' },
    },
  ])('keeps $name state outside cleanup', ({ state }) => {
    let now = 0;
    const history = new BoundedResponseHistoryStore({
      inactiveTtlMs: 10,
      now: () => now,
    });
    const authoritativeStateBeforeCleanup = JSON.stringify(state);
    history.beginTurn({ clientId: 'pixel-overlay', turnId: 'request-one' });
    now = 10;

    expect(history.cleanup()).toBe(1);
    expect(history.snapshot('pixel-overlay')).toBeUndefined();
    expect(state).toEqual(JSON.parse(authoritativeStateBeforeCleanup));
  });

  it('supports explicit start-over and rejects stale completions', () => {
    const history = new BoundedResponseHistoryStore();
    history.beginTurn({ clientId: 'pixel-overlay', turnId: 'request-one' });
    const reset = history.beginTurn({
      clientId: 'pixel-overlay',
      startOver: true,
      turnId: 'request-two',
    });

    expect(reset.resetReason).toBe('start_over');
    expect(history.completeTurn({
      clientId: 'pixel-overlay',
      responseCount: 1,
      responseId: 'resp_12345678',
      turnId: 'request-one',
    })).toBe(false);
    expect(isStartOverRequest('Please start over.')).toBe(true);
    expect(isStartOverRequest('start over and add milk')).toBe(false);
  });

  it('stores metadata only and refuses response content as identifiers', () => {
    const history = new BoundedResponseHistoryStore();
    history.beginTurn({ clientId: 'pixel-overlay', turnId: 'request-one' });

    expect(() => history.completeTurn({
      clientId: 'pixel-overlay',
      responseCount: 1,
      responseId: 'Here is your cart and home address',
      turnId: 'request-one',
    })).toThrow(/opaque OpenAI response identifier/);
    expect(JSON.stringify(history.snapshot('pixel-overlay'))).not.toMatch(
      /transcript|audio|image|address|payment|milk/i,
    );
  });
});
