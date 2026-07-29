import type { AndroidCartReviewV1 } from '@errandos/contracts';

/**
 * Carries the one ordinary post-mutation cart observation across the driver
 * boundary. Callers may reconcile this evidence, but must not automatically
 * repeat either the mutation or the ordinary cart inspection.
 */
export class AndroidCartMutationVerificationError extends Error {
  public override readonly name = 'AndroidCartMutationVerificationError';

  public constructor(
    public readonly observedCart: AndroidCartReviewV1 | undefined,
    options: ErrorOptions = {},
  ) {
    super('Blinkit cart_item_verify failed', options);
  }
}
