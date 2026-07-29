import { describe, expect, it } from 'vitest';
import {
  companionIssueForBackgroundOperationV2,
  companionIssueForCheckoutStatusV2,
  companionIssueForToolResultV2,
  companionIssueV2,
  type CompanionIssueCodeV2,
  type CompanionIssueSignalV2,
  type RecoveryActionIdV2,
} from './companion-issue';

const cases = [
  ['system', 'unknown', 'unknown_failure', ['stop_task']],
  ['server', 'unreachable', 'server_unreachable', ['reconnect_server', 'stop_task']],
  ['adb_device', 'disconnected', 'phone_disconnected', ['reconnect_phone', 'stop_task']],
  ['adb_device', 'unauthorized', 'phone_unauthorized', ['reconnect_phone', 'stop_task']],
  ['appium', 'unavailable', 'appium_unavailable', ['reconnect_appium', 'stop_task']],
  [
    'appium',
    'session_recovery_failed',
    'appium_session_recovery_failed',
    ['reconnect_appium', 'stop_task'],
  ],
  ['device_lock', 'locked', 'device_locked', ['unlock_phone', 'stop_task']],
  [
    'blinkit_authentication',
    'login_required',
    'blinkit_login_required',
    ['open_blinkit', 'stop_task'],
  ],
  [
    'provider_screen',
    'unavailable',
    'provider_screen_unavailable',
    ['refresh_provider_screen', 'stop_task'],
  ],
  [
    'provider_screen',
    'unexpected',
    'provider_screen_unexpected',
    ['open_blinkit', 'refresh_provider_screen', 'stop_task'],
  ],
  [
    'speech_provider',
    'unavailable',
    'speech_provider_unavailable',
    ['retry_speech', 'stop_task'],
  ],
  ['search', 'no_match', 'search_no_match', ['refine_search', 'stop_task']],
  ['search', 'failed', 'search_failed', ['refresh_choices', 'stop_task']],
  [
    'search',
    'choice_expired',
    'search_choice_expired',
    ['refresh_choices', 'stop_task'],
  ],
  [
    'mutation',
    'verified_not_applied',
    'mutation_verified_not_applied',
    ['retry_verified_not_applied', 'stop_task'],
  ],
  [
    'mutation',
    'ambiguous',
    'mutation_ambiguous',
    ['check_cart_again', 'stop_task'],
  ],
  [
    'reconciliation',
    'required',
    'reconciliation_required',
    ['check_cart_again', 'stop_task'],
  ],
  [
    'checkout',
    'changed',
    'checkout_changed',
    ['refresh_checkout', 'stop_task'],
  ],
  [
    'checkout',
    'expired',
    'checkout_expired',
    ['refresh_checkout', 'stop_task'],
  ],
  [
    'checkout',
    'blocked',
    'checkout_blocked',
    ['open_blinkit', 'refresh_checkout', 'stop_task'],
  ],
  [
    'final_dispatch',
    'ambiguous',
    'final_dispatch_ambiguous',
    ['check_order_status', 'stop_task'],
  ],
  [
    'final_dispatch',
    'blocked',
    'final_dispatch_blocked',
    ['refresh_checkout', 'stop_task'],
  ],
] as const satisfies ReadonlyArray<readonly [
  CompanionIssueSignalV2['stage'],
  string,
  CompanionIssueCodeV2,
  readonly RecoveryActionIdV2[],
]>;

describe('companion issue taxonomy v2', () => {
  it.each(cases)(
    'maps %s:%s to stable issue %s',
    (stage, status, code, expectedActions) => {
      const issue = companionIssueV2({ version: 2, stage, status });

      expect(issue).toMatchObject({
        version: 2,
        code,
      });
      expect(issue.recoveryActions.map((action) => action.actionId))
        .toEqual(expectedActions);
      expect(issue.title.length).toBeGreaterThan(0);
      expect(issue.detail.length).toBeGreaterThan(0);
    },
  );

  it('covers every stable issue code exactly once', () => {
    const codes = cases.map((entry) => entry[2]);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(22);
  });

  it('accepts only exact bounded status/stage signals', () => {
    for (const value of [
      null,
      [],
      {},
      { version: 1, stage: 'server', status: 'unreachable' },
      { version: 2, stage: 'server', status: 'timeout' },
      {
        version: 2,
        stage: 'server',
        status: 'unreachable',
        rawError: 'secret provider response',
      },
      {
        version: 2,
        stage: 'search',
        status: 'failed',
        message: 'user-authored product text',
      },
    ]) {
      expect(() => companionIssueV2(value)).toThrow();
    }
  });

  it('never copies raw input or mutable policy state into public output', () => {
    const signal = {
      version: 2,
      stage: 'server',
      status: 'unreachable',
    } as const;
    const first = companionIssueV2(signal);
    first.recoveryActions[0]!.label = 'changed by caller';
    const second = companionIssueV2(signal);

    expect(JSON.stringify(second)).not.toContain('changed by caller');
    expect(Object.keys(second).sort()).toEqual([
      'code',
      'detail',
      'queueBehavior',
      'recoveryActions',
      'title',
      'treatment',
      'version',
    ]);
  });

  it('never offers mutation retry for ambiguity or reconciliation', () => {
    const ambiguous = companionIssueV2({
      version: 2,
      stage: 'mutation',
      status: 'ambiguous',
    });
    const reconciliation = companionIssueV2({
      version: 2,
      stage: 'reconciliation',
      status: 'required',
    });

    for (const issue of [ambiguous, reconciliation]) {
      expect(issue.queueBehavior).toBe('stop_queue');
      expect(issue.recoveryActions).toEqual([
        expect.objectContaining({
          actionId: 'check_cart_again',
          safety: 'read_only',
        }),
        expect.objectContaining({
          actionId: 'stop_task',
          safety: 'stop_only',
        }),
      ]);
      expect(issue.recoveryActions.some(
        (action) => action.actionId === 'retry_verified_not_applied',
      )).toBe(false);
    }
  });

  it('gates the sole mutation retry behind verified-not-applied truth', () => {
    const issues = cases.map(([stage, status]) =>
      companionIssueV2({ version: 2, stage, status }));
    const retryOwners = issues.filter((issue) => issue.recoveryActions.some(
      (action) => action.actionId === 'retry_verified_not_applied',
    ));

    expect(retryOwners).toHaveLength(1);
    expect(retryOwners[0]).toMatchObject({
      code: 'mutation_verified_not_applied',
      recoveryActions: [
        {
          actionId: 'retry_verified_not_applied',
          safety: 'verified_not_applied_only',
        },
        {
          actionId: 'stop_task',
          safety: 'stop_only',
        },
      ],
    });
  });

  it.each([
    [{ status: 'server_unreachable' }, 'server_unreachable'],
    [{ status: 'phone_disconnected' }, 'phone_disconnected'],
    [{ status: 'phone_unauthorized' }, 'phone_unauthorized'],
    [{ status: 'appium_unavailable' }, 'appium_unavailable'],
    [{ status: 'session_recovery_failed' }, 'appium_session_recovery_failed'],
    [{ status: 'device_locked' }, 'device_locked'],
    [{ status: 'login_required' }, 'blinkit_login_required'],
    [{ status: 'provider_screen_unavailable' }, 'provider_screen_unavailable'],
    [{ status: 'provider_screen_unexpected' }, 'provider_screen_unexpected'],
    [{ status: 'speech_provider_unavailable' }, 'speech_provider_unavailable'],
    [{ status: 'choice_expired' }, 'search_choice_expired'],
    [{ status: 'not_found' }, 'search_no_match'],
    [{ status: 'search_failed' }, 'search_failed'],
    [
      {
        status: 'mutation_verified_not_applied',
        verification: { outcome: 'verified_not_applied' },
      },
      'mutation_verified_not_applied',
    ],
    [{ status: 'mutation_outcome_ambiguous' }, 'mutation_ambiguous'],
    [{ status: 'reconciliation_required' }, 'mutation_ambiguous'],
    [{ status: 'checkout_changed' }, 'checkout_changed'],
    [{ status: 'checkout_expired' }, 'checkout_expired'],
    [{ status: 'checkout_orchestration_rejected' }, 'checkout_blocked'],
    [{ status: 'order_status_ambiguous' }, 'final_dispatch_ambiguous'],
    [{ status: 'final_dispatch_blocked' }, 'final_dispatch_blocked'],
    [{ ok: false, status: 'new_provider_failure' }, 'unknown_failure'],
  ] as const)(
    'maps bounded tool result %# to %s',
    (result, code) => {
      expect(companionIssueForToolResultV2(result)?.code).toBe(code);
    },
  );

  it('maps structured execution failure stages without reading raw prose', () => {
    const raw = 'selector with private account content';
    const issue = companionIssueForToolResultV2({
      ok: false,
      status: 'execution_failed',
      failure: {
        stage: 'recovery',
        reason: raw,
      },
      message: raw,
    });

    expect(issue?.code).toBe('appium_session_recovery_failed');
    expect(JSON.stringify(issue)).not.toContain(raw);
  });

  it.each([
    ['search_products', 'failed', 'search_failed'],
    ['prepare_checkout', 'failed', 'checkout_blocked'],
    ['add_cart_item', 'failed', 'unknown_failure'],
    ['add_cart_item', 'ambiguous', 'mutation_ambiguous'],
    ['inspect_cart', 'ambiguous', 'reconciliation_required'],
  ] as const)(
    'maps durable %s:%s to %s',
    (operationKind, status, code) => {
      expect(companionIssueForBackgroundOperationV2({
        operationKind,
        status,
      })?.code).toBe(code);
    },
  );

  it.each([
    ['checkout_changed', 'checkout_changed'],
    ['checkout_expired', 'checkout_expired'],
    ['review_expired', 'checkout_expired'],
    ['blocked', 'checkout_blocked'],
    ['order_status_ambiguous', 'final_dispatch_ambiguous'],
  ] as const)(
    'maps checkout status %s to %s',
    (status, code) => {
      expect(companionIssueForCheckoutStatusV2(status)?.code).toBe(code);
    },
  );

  it('does not manufacture issues for successful or unknown neutral results', () => {
    expect(companionIssueForToolResultV2({
      ok: true,
      status: 'added',
    })).toBeUndefined();
    expect(companionIssueForCheckoutStatusV2('ordered')).toBeUndefined();
    expect(companionIssueForBackgroundOperationV2({
      operationKind: 'add_cart_item',
      status: 'completed',
    })).toBeUndefined();
  });
});
