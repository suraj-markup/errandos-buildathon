import { traceFunction } from './structured-logger';

export type SelectedProductOffer = {
  offerId: string;
  packSize?: string;
  priceAmount: number;
  priceCurrency: 'INR';
  title: string;
};

export type ProductMutationVerification = {
  afterItemFingerprint?: string;
  beforeItemFingerprint?: string;
  directControl: 'changed' | 'unchanged' | 'unknown';
  identityResolution?: 'ambiguous' | 'none' | 'unique';
  conflicts?: readonly {
    field: 'pack_size' | 'price';
    expected: string;
    observed: string;
  }[];
  mutationAttempted: boolean;
  postCart?: {
    cart?: {
      lines: readonly {
        packSize?: string;
        price?: string;
        product: string;
        productId: string;
        quantity: number;
      }[];
    };
    ok: true;
    status: 'cart_empty' | 'cart_status';
  };
  outcome:
    | 'ambiguous'
    | 'failed_before_mutation'
    | 'verified_no_change'
    | 'verified_success';
  reconciliation:
    | 'inspection_failed'
    | 'mismatch'
    | 'not_run'
    | 'verified';
  unrelatedCartPreserved: boolean | null;
};

export type SequentialProductAction = {
  action: 'add_cart_item' | 'search_products';
  offerId?: string;
  quantity?: number;
  reconcileOnly?: boolean;
  request: string;
  searchQuery?: string;
  selectedOffer?: SelectedProductOffer;
};

type SequentialProductResult = {
  status?: string;
};

type SequentialProductCheckpoint<T extends SequentialProductResult> = {
  action: SequentialProductAction;
  actionIndex: number;
  nextAction?: SequentialProductAction;
  remainingCount: number;
  result: T;
};

const choiceStatuses = new Set([
  'needs_clarification',
  'search_results',
]);

const retryStatuses = new Set([
  'automation_failed',
  'cart_item_not_found',
  'device_locked',
  'execution_failed',
  'execution_guard_error',
  'idempotency_conflict',
  'invalid_command',
  'invalid_quantity',
  'mutation_outcome_ambiguous',
  'not_found',
  'reconciliation_required',
  'retry_allowed',
]);

export function isSequentialProductAction(
  action: { action?: string },
): action is SequentialProductAction {
  return action.action === 'add_cart_item' || action.action === 'search_products';
}

export function productResultNeedsUserInput(result: SequentialProductResult): boolean {
  const status = result.status ?? '';
  return choiceStatuses.has(status) || retryStatuses.has(status);
}

export async function executeSequentialProductQueue<T extends SequentialProductResult>(
  actions: readonly SequentialProductAction[],
  execute: (action: SequentialProductAction) => Promise<T>,
  options: {
    onResult?: (
      checkpoint: SequentialProductCheckpoint<T>,
    ) => Promise<void> | void;
  } = {},
): Promise<{
  blockedAction?: SequentialProductAction;
  executedActions: SequentialProductAction[];
  remainingActions: SequentialProductAction[];
  results: T[];
}> {
  return traceFunction(
    'workflow.executeSequentialProductQueue',
    {
      actionCount: actions.length,
      actions,
    },
    async () => {
      const remainingActions = [...actions];
      const executedActions: SequentialProductAction[] = [];
      const results: T[] = [];
      let blockedAction: SequentialProductAction | undefined;

      while (remainingActions.length > 0) {
        const action = remainingActions.shift()!;
        const result = await execute(action);
        executedActions.push(action);
        results.push(result);
        await options.onResult?.({
          action,
          actionIndex: executedActions.length - 1,
          ...(remainingActions[0]
            ? { nextAction: remainingActions[0] }
            : {}),
          remainingCount: remainingActions.length,
          result,
        });

        if (productResultNeedsUserInput(result)) {
          blockedAction = action;
          break;
        }
      }

      return {
        ...(blockedAction ? { blockedAction } : {}),
        executedActions,
        remainingActions,
        results,
      };
    },
    (result) => ({
      blockedAction: result.blockedAction,
      executedCount: result.executedActions.length,
      remainingCount: result.remainingActions.length,
      resultStatuses: result.results.map((entry) => entry.status),
    }),
  );
}
