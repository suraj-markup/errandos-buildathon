import { describe, expect, it } from 'vitest';
import { preserveUserGoalV2 } from './goal';

describe('PhoneTaskV2 goal preservation', () => {
  it.each([
    [
      'Add milk and bread to my cart',
      'cart_ready',
      undefined,
    ],
    [
      'Add milk and bread, then ask me what to do next',
      'ask_next',
      undefined,
    ],
    [
      'Add milk and bread and then review the checkout',
      'checkout_reviewed',
      'ask_user',
    ],
    [
      'Add milk and bread and review checkout using COD',
      'checkout_reviewed',
      'cod',
    ],
    [
      'Add milk and bread and then place the order with cash on delivery',
      'order_placed',
      'cod',
    ],
  ])(
    'preserves terminal intent for %s',
    (goal, expectedKind, expectedPayment) => {
      const parsed = preserveUserGoalV2(goal);

      expect(parsed.originalGoal).toBe(goal);
      expect(parsed.requests.map((request) => request.subject))
        .toEqual(['milk', 'bread']);
      expect(parsed.desiredTerminalOutcome).toMatchObject({
        kind: expectedKind,
        ...(expectedPayment ? { paymentPreference: expectedPayment } : {}),
      });
    },
  );

  it('extracts quantities and bounded constraints without replacing the goal', () => {
    const goal = 'Please add two Amul milk 500 ml and 3 bread packets';
    const parsed = preserveUserGoalV2(goal);

    expect(parsed.originalGoal).toBe(goal);
    expect(parsed.requests).toEqual([
      {
        kind: 'add',
        subject: 'Amul milk 500 ml',
        quantity: 2,
        constraints: ['500 ml'],
      },
      {
        kind: 'add',
        subject: 'bread packets',
        quantity: 3,
        constraints: [],
      },
    ]);
  });

  it('rejects an empty goal', () => {
    expect(() => preserveUserGoalV2('   ')).toThrow('cannot be empty');
  });
});
