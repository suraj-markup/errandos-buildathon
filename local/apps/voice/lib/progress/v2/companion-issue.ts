/**
 * Stable, presentation-safe issue taxonomy for the V2 companion.
 *
 * The mapper deliberately accepts only a version, stage, and status from a
 * closed union. Raw provider errors, selectors, screenshots, account data,
 * product data, and user-authored text do not belong at this boundary.
 */

export type CompanionIssueSignalV2 =
  | { version: 2; stage: 'system'; status: 'unknown' }
  | { version: 2; stage: 'server'; status: 'unreachable' }
  | {
      version: 2;
      stage: 'adb_device';
      status: 'disconnected' | 'unauthorized';
    }
  | {
      version: 2;
      stage: 'appium';
      status: 'session_recovery_failed' | 'unavailable';
    }
  | { version: 2; stage: 'device_lock'; status: 'locked' }
  | {
      version: 2;
      stage: 'blinkit_authentication';
      status: 'login_required';
    }
  | {
      version: 2;
      stage: 'provider_screen';
      status: 'unavailable' | 'unexpected';
    }
  | { version: 2; stage: 'speech_provider'; status: 'unavailable' }
  | {
      version: 2;
      stage: 'search';
      status: 'choice_expired' | 'failed' | 'no_match';
    }
  | {
      version: 2;
      stage: 'mutation';
      status: 'ambiguous' | 'verified_not_applied';
    }
  | { version: 2; stage: 'reconciliation'; status: 'required' }
  | {
      version: 2;
      stage: 'checkout';
      status: 'blocked' | 'changed' | 'expired';
    }
  | {
      version: 2;
      stage: 'final_dispatch';
      status: 'ambiguous' | 'blocked';
    };

export type CompanionIssueCodeV2 =
  | 'unknown_failure'
  | 'server_unreachable'
  | 'phone_disconnected'
  | 'phone_unauthorized'
  | 'appium_unavailable'
  | 'appium_session_recovery_failed'
  | 'device_locked'
  | 'blinkit_login_required'
  | 'provider_screen_unavailable'
  | 'provider_screen_unexpected'
  | 'speech_provider_unavailable'
  | 'search_choice_expired'
  | 'search_failed'
  | 'search_no_match'
  | 'mutation_ambiguous'
  | 'mutation_verified_not_applied'
  | 'reconciliation_required'
  | 'checkout_blocked'
  | 'checkout_changed'
  | 'checkout_expired'
  | 'final_dispatch_ambiguous'
  | 'final_dispatch_blocked';

export type CompanionIssueTreatmentV2 =
  | 'connection_blocked'
  | 'user_attention'
  | 'search_refinement'
  | 'safe_failure'
  | 'reconciliation'
  | 'checkout_review'
  | 'final_dispatch_attention';

export type CompanionIssueQueueBehaviorV2 =
  | 'pause_current_item'
  | 'pause_task'
  | 'stop_queue'
  | 'terminal_hold';

export type RecoveryActionIdV2 =
  | 'check_cart_again'
  | 'check_order_status'
  | 'open_blinkit'
  | 'reconnect_appium'
  | 'reconnect_phone'
  | 'reconnect_server'
  | 'refine_search'
  | 'refresh_checkout'
  | 'refresh_choices'
  | 'refresh_provider_screen'
  | 'retry_speech'
  | 'retry_verified_not_applied'
  | 'stop_task'
  | 'unlock_phone';

type NonMutationRecoveryActionV2 = {
  version: 2;
  actionId: Exclude<
    RecoveryActionIdV2,
    'retry_verified_not_applied'
  >;
  label: string;
  safety:
    | 'read_only'
    | 'stop_only'
    | 'user_guidance';
};

type VerifiedNotAppliedRetryActionV2 = {
  version: 2;
  actionId: 'retry_verified_not_applied';
  label: 'Try the cart change again';
  safety: 'verified_not_applied_only';
};

/**
 * `retry_verified_not_applied` is the only phone-mutation retry action. Its
 * discriminant prevents an ambiguous outcome from being represented as a
 * retryable mutation.
 */
export type RecoveryActionV2 =
  | NonMutationRecoveryActionV2
  | VerifiedNotAppliedRetryActionV2;

export type CompanionIssueV2 = {
  version: 2;
  code: CompanionIssueCodeV2;
  treatment: CompanionIssueTreatmentV2;
  queueBehavior: CompanionIssueQueueBehaviorV2;
  title: string;
  detail: string;
  recoveryActions: RecoveryActionV2[];
};

type SignalKeyV2<T extends CompanionIssueSignalV2 =
CompanionIssueSignalV2> = T extends CompanionIssueSignalV2
  ? `${T['stage']}:${T['status']}`
  : never;

type CompanionIssuePolicyV2 = Omit<CompanionIssueV2, 'version'>;

function action(
  actionId: NonMutationRecoveryActionV2['actionId'],
  label: string,
  safety: NonMutationRecoveryActionV2['safety'],
): NonMutationRecoveryActionV2 {
  return { version: 2, actionId, label, safety };
}

const stopTask = action('stop_task', 'Stop task', 'stop_only');

const policies = {
  'system:unknown': {
    code: 'unknown_failure',
    treatment: 'safe_failure',
    queueBehavior: 'pause_task',
    title: 'Task paused',
    detail: 'JaldiAI could not complete this step safely.',
    recoveryActions: [stopTask],
  },
  'server:unreachable': {
    code: 'server_unreachable',
    treatment: 'connection_blocked',
    queueBehavior: 'pause_task',
    title: 'JaldiAI server unavailable',
    detail: 'Task updates are paused until the server reconnects.',
    recoveryActions: [
      action('reconnect_server', 'Reconnect', 'read_only'),
      stopTask,
    ],
  },
  'adb_device:disconnected': {
    code: 'phone_disconnected',
    treatment: 'connection_blocked',
    queueBehavior: 'pause_task',
    title: 'Phone connection lost',
    detail: 'No new phone action will run until the device reconnects.',
    recoveryActions: [
      action('reconnect_phone', 'Reconnect phone', 'read_only'),
      stopTask,
    ],
  },
  'adb_device:unauthorized': {
    code: 'phone_unauthorized',
    treatment: 'user_attention',
    queueBehavior: 'pause_task',
    title: 'Phone authorization required',
    detail: 'Approve the debugging connection on the phone to continue.',
    recoveryActions: [
      action('reconnect_phone', 'Check connection', 'read_only'),
      stopTask,
    ],
  },
  'appium:unavailable': {
    code: 'appium_unavailable',
    treatment: 'connection_blocked',
    queueBehavior: 'pause_task',
    title: 'Phone control unavailable',
    detail: 'The phone automation service is not reachable.',
    recoveryActions: [
      action('reconnect_appium', 'Reconnect phone control', 'read_only'),
      stopTask,
    ],
  },
  'appium:session_recovery_failed': {
    code: 'appium_session_recovery_failed',
    treatment: 'connection_blocked',
    queueBehavior: 'pause_task',
    title: 'Phone session needs recovery',
    detail: 'The existing phone session could not be restored safely.',
    recoveryActions: [
      action('reconnect_appium', 'Restore phone session', 'read_only'),
      stopTask,
    ],
  },
  'device_lock:locked': {
    code: 'device_locked',
    treatment: 'user_attention',
    queueBehavior: 'pause_task',
    title: 'Unlock your phone',
    detail: 'The task is paused while the phone is locked.',
    recoveryActions: [
      action('unlock_phone', 'Unlock phone', 'user_guidance'),
      stopTask,
    ],
  },
  'blinkit_authentication:login_required': {
    code: 'blinkit_login_required',
    treatment: 'user_attention',
    queueBehavior: 'pause_task',
    title: 'Blinkit sign-in required',
    detail: 'Sign in to Blinkit on the phone before the task continues.',
    recoveryActions: [
      action('open_blinkit', 'Open Blinkit', 'user_guidance'),
      stopTask,
    ],
  },
  'provider_screen:unavailable': {
    code: 'provider_screen_unavailable',
    treatment: 'user_attention',
    queueBehavior: 'pause_task',
    title: 'Blinkit screen unavailable',
    detail: 'JaldiAI cannot safely identify the current Blinkit screen.',
    recoveryActions: [
      action(
        'refresh_provider_screen',
        'Check Blinkit again',
        'read_only',
      ),
      stopTask,
    ],
  },
  'provider_screen:unexpected': {
    code: 'provider_screen_unexpected',
    treatment: 'user_attention',
    queueBehavior: 'pause_task',
    title: 'Blinkit needs attention',
    detail: 'Open the expected Blinkit screen before continuing.',
    recoveryActions: [
      action('open_blinkit', 'Open Blinkit', 'user_guidance'),
      action(
        'refresh_provider_screen',
        'Check screen again',
        'read_only',
      ),
      stopTask,
    ],
  },
  'speech_provider:unavailable': {
    code: 'speech_provider_unavailable',
    treatment: 'connection_blocked',
    queueBehavior: 'pause_task',
    title: 'Voice service unavailable',
    detail: 'Voice input is temporarily unavailable. No phone action ran.',
    recoveryActions: [
      action('retry_speech', 'Try voice again', 'read_only'),
      stopTask,
    ],
  },
  'search:no_match': {
    code: 'search_no_match',
    treatment: 'search_refinement',
    queueBehavior: 'pause_current_item',
    title: 'No matching product found',
    detail: 'Refine this item or skip it before the task continues.',
    recoveryActions: [
      action('refine_search', 'Refine search', 'user_guidance'),
      stopTask,
    ],
  },
  'search:failed': {
    code: 'search_failed',
    treatment: 'safe_failure',
    queueBehavior: 'pause_current_item',
    title: 'Blinkit search did not finish',
    detail: 'The search can be refreshed without changing the cart.',
    recoveryActions: [
      action('refresh_choices', 'Search again', 'read_only'),
      stopTask,
    ],
  },
  'search:choice_expired': {
    code: 'search_choice_expired',
    treatment: 'search_refinement',
    queueBehavior: 'pause_current_item',
    title: 'Product choices expired',
    detail: 'Refresh the choices before selecting a product.',
    recoveryActions: [
      action('refresh_choices', 'Refresh choices', 'read_only'),
      stopTask,
    ],
  },
  'mutation:verified_not_applied': {
    code: 'mutation_verified_not_applied',
    treatment: 'safe_failure',
    queueBehavior: 'pause_current_item',
    title: 'Cart change was not applied',
    detail: 'A fresh check proved the requested cart change did not happen.',
    recoveryActions: [
      {
        version: 2,
        actionId: 'retry_verified_not_applied',
        label: 'Try the cart change again',
        safety: 'verified_not_applied_only',
      },
      stopTask,
    ],
  },
  'mutation:ambiguous': {
    code: 'mutation_ambiguous',
    treatment: 'reconciliation',
    queueBehavior: 'stop_queue',
    title: 'Checking what happened',
    detail: 'The cart change will not be repeated until its result is known.',
    recoveryActions: [
      action('check_cart_again', 'Check cart again', 'read_only'),
      stopTask,
    ],
  },
  'reconciliation:required': {
    code: 'reconciliation_required',
    treatment: 'reconciliation',
    queueBehavior: 'stop_queue',
    title: 'Cart verification required',
    detail: 'JaldiAI must read the current cart before any retry.',
    recoveryActions: [
      action('check_cart_again', 'Check cart again', 'read_only'),
      stopTask,
    ],
  },
  'checkout:changed': {
    code: 'checkout_changed',
    treatment: 'checkout_review',
    queueBehavior: 'pause_task',
    title: 'Checkout details changed',
    detail: 'Review fresh checkout details before confirming anything.',
    recoveryActions: [
      action('refresh_checkout', 'Review checkout again', 'read_only'),
      stopTask,
    ],
  },
  'checkout:expired': {
    code: 'checkout_expired',
    treatment: 'checkout_review',
    queueBehavior: 'pause_task',
    title: 'Checkout review expired',
    detail: 'A fresh checkout review is required. Nothing was ordered.',
    recoveryActions: [
      action('refresh_checkout', 'Refresh checkout', 'read_only'),
      stopTask,
    ],
  },
  'checkout:blocked': {
    code: 'checkout_blocked',
    treatment: 'checkout_review',
    queueBehavior: 'pause_task',
    title: 'Checkout needs attention',
    detail: 'Resolve the checkout issue in Blinkit before continuing.',
    recoveryActions: [
      action('open_blinkit', 'Open Blinkit', 'user_guidance'),
      action('refresh_checkout', 'Check checkout again', 'read_only'),
      stopTask,
    ],
  },
  'final_dispatch:ambiguous': {
    code: 'final_dispatch_ambiguous',
    treatment: 'final_dispatch_attention',
    queueBehavior: 'terminal_hold',
    title: 'Order status needs verification',
    detail: 'JaldiAI will not place the order again while its status is unknown.',
    recoveryActions: [
      action(
        'check_order_status',
        'Check recent orders',
        'read_only',
      ),
      stopTask,
    ],
  },
  'final_dispatch:blocked': {
    code: 'final_dispatch_blocked',
    treatment: 'final_dispatch_attention',
    queueBehavior: 'terminal_hold',
    title: 'Order was not placed',
    detail: 'Return to checkout review before attempting a new order.',
    recoveryActions: [
      action('refresh_checkout', 'Review checkout again', 'read_only'),
      stopTask,
    ],
  },
} as const satisfies Record<SignalKeyV2, CompanionIssuePolicyV2>;

function ownKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function parseSignal(value: unknown): CompanionIssueSignalV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Companion issue signal must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (
    ownKeys(input).join(',') !== 'stage,status,version'
    || input['version'] !== 2
    || typeof input['stage'] !== 'string'
    || typeof input['status'] !== 'string'
  ) {
    throw new Error(
      'Companion issue signal requires exact version, stage, and status.',
    );
  }
  const key = `${input['stage']}:${input['status']}`;
  if (!Object.prototype.hasOwnProperty.call(policies, key)) {
    throw new Error('Unsupported companion issue signal.');
  }
  return input as CompanionIssueSignalV2;
}

function signalKey(signal: CompanionIssueSignalV2): SignalKeyV2 {
  return `${signal.stage}:${signal.status}` as SignalKeyV2;
}

/**
 * Maps one bounded execution signal to deterministic public UI policy.
 * Returned values are copied so callers cannot mutate the shared policy.
 */
export function companionIssueV2(value: unknown): CompanionIssueV2 {
  const policy = policies[signalKey(parseSignal(value))];
  return {
    version: 2,
    code: policy.code,
    treatment: policy.treatment,
    queueBehavior: policy.queueBehavior,
    title: policy.title,
    detail: policy.detail,
    recoveryActions: policy.recoveryActions.map((candidate) => ({
      ...candidate,
    })),
  };
}

type CompanionIssueOperationV2 = {
  operationKind: string;
  status: 'completed' | 'failed' | 'ambiguous';
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function issue(
  stage: CompanionIssueSignalV2['stage'],
  status: string,
): CompanionIssueV2 {
  return companionIssueV2({ version: 2, stage, status });
}

/**
 * Maps only bounded public tool-result discriminants. Provider prose, raw
 * exceptions, product text, selectors, and screenshots are deliberately
 * ignored. Successful/non-terminal results do not manufacture an issue.
 */
export function companionIssueForToolResultV2(
  value: unknown,
): CompanionIssueV2 | undefined {
  const input = record(value);
  if (!input) return undefined;
  const status = typeof input['status'] === 'string'
    ? input['status']
    : '';
  const failure = record(input['failure']);
  const verification = record(input['verification']);

  if (
    status === 'mutation_outcome_ambiguous'
    || status === 'reconciliation_required'
    || (
      status === 'execution_failed'
      && verification?.['mutationAttempted'] === true
      && verification['outcome'] === 'ambiguous'
    )
  ) {
    return issue('mutation', 'ambiguous');
  }
  if (
    status === 'mutation_verified_not_applied'
    || verification?.['outcome'] === 'verified_not_applied'
  ) {
    return issue('mutation', 'verified_not_applied');
  }

  switch (status) {
    case 'server_unreachable':
      return issue('server', 'unreachable');
    case 'phone_disconnected':
      return issue('adb_device', 'disconnected');
    case 'phone_unauthorized':
      return issue('adb_device', 'unauthorized');
    case 'appium_unavailable':
      return issue('appium', 'unavailable');
    case 'session_recovery_failed':
      return issue('appium', 'session_recovery_failed');
    case 'device_locked':
      return issue('device_lock', 'locked');
    case 'authentication_required':
    case 'login_required':
      return issue('blinkit_authentication', 'login_required');
    case 'provider_screen_unavailable':
      return issue('provider_screen', 'unavailable');
    case 'provider_screen_unexpected':
      return issue('provider_screen', 'unexpected');
    case 'speech_provider_unavailable':
      return issue('speech_provider', 'unavailable');
    case 'choice_expired':
      return issue('search', 'choice_expired');
    case 'not_found':
    case 'search_no_match':
      return issue('search', 'no_match');
    case 'search_failed':
      return issue('search', 'failed');
    case 'checkout_changed':
      return issue('checkout', 'changed');
    case 'checkout_expired':
      return issue('checkout', 'expired');
    case 'checkout_orchestration_rejected':
    case 'final_dispatch_disabled':
      return issue('checkout', 'blocked');
    case 'order_status_ambiguous':
      return issue('final_dispatch', 'ambiguous');
    case 'final_dispatch_blocked':
      return issue('final_dispatch', 'blocked');
    default:
      break;
  }

  if (status === 'execution_failed') {
    switch (failure?.['stage']) {
      case 'device':
        return issue('adb_device', 'disconnected');
      case 'recovery':
        return issue('appium', 'session_recovery_failed');
      case 'search':
        return issue('search', 'failed');
      case 'matching':
        return issue('search', 'no_match');
      case 'verification':
        return issue('reconciliation', 'required');
      default:
        return issue('system', 'unknown');
    }
  }

  if (
    input['ok'] === false
    || status.endsWith('_failed')
    || status.endsWith('_unavailable')
    || status.endsWith('_blocked')
  ) {
    return issue('system', 'unknown');
  }
  return undefined;
}

/**
 * Durable background operations intentionally retain only their stable status
 * and operation kind. An ambiguous cart mutation is always reconciliation
 * only; a failed mutation is not labelled retryable without explicit
 * verified-not-applied evidence.
 */
export function companionIssueForBackgroundOperationV2(
  operation: CompanionIssueOperationV2,
): CompanionIssueV2 | undefined {
  if (operation.status === 'completed') return undefined;
  if (operation.status === 'ambiguous') {
    return ['add_cart_item', 'set_cart_item_quantity', 'remove_cart_item']
        .includes(operation.operationKind)
      ? issue('mutation', 'ambiguous')
      : issue('reconciliation', 'required');
  }
  if (operation.operationKind === 'search_products') {
    return issue('search', 'failed');
  }
  if (operation.operationKind === 'prepare_checkout') {
    return issue('checkout', 'blocked');
  }
  return issue('system', 'unknown');
}

/**
 * Checkout recovery/result mapping is kept pure so checkout adapters can
 * project the same public treatment without coupling to their repositories.
 */
export function companionIssueForCheckoutStatusV2(
  status: unknown,
): CompanionIssueV2 | undefined {
  switch (status) {
    case 'checkout_changed':
      return issue('checkout', 'changed');
    case 'checkout_expired':
    case 'review_expired':
      return issue('checkout', 'expired');
    case 'blocked':
    case 'checkout_orchestration_rejected':
    case 'final_dispatch_disabled':
      return issue('checkout', 'blocked');
    case 'ambiguous':
    case 'order_status_ambiguous':
      return issue('final_dispatch', 'ambiguous');
    default:
      return undefined;
  }
}
