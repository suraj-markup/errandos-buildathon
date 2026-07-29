import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  AndroidCartMutationVerificationError,
  AppiumHttpClient,
  AppiumSessionPool,
  BlinkitAndroidDriver,
  FileAndroidCommitStore,
  commitOnce,
  reconcileProviderProductIdentity,
  reconcileFromOrderHistory,
  type AndroidCommitStore,
  type AndroidSearchOffer,
} from '@errandos/provider-connectors';
import type {
  AndroidCheckoutReviewV1,
  AndroidExpectedCheckoutV1,
} from '@errandos/contracts';
import {
  buildCodCheckoutProposal,
  checkoutTermChanges,
  type CodCheckoutProposalV1,
} from './cod';
import { publishOverlayStatus } from './overlay';
import type { OverlayTaskProgressStageV1 } from '@errandos/contracts';
import { buildProductSpokenLabels } from './product-label';
import type {
  ProductMutationVerification,
  SelectedProductOffer,
} from './product-workflow';
import { errorDetails, logEvent } from './structured-logger';
import { stageMetrics } from './stage-metrics';
import type { CurrentScreenEvidence } from './voice-presentation';
import {
  PhoneOperationCancelledError,
  type PhoneOperationExecutionControl,
} from './operation-queue';
import {
  attachSharedCartInspectionEvidenceV2,
} from './execution/v2/cart-inspection-evidence';
import {
  BLINKIT_APPIUM_DEVICE_KEY,
  blinkitAppiumSessionPool,
} from './appium';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const DEVICE_UDID = process.env.ANDROID_DEVICE_UDID;
const BLINKIT_PACKAGE = 'com.grofers.customerapp';

const ignoredRequestWords = new Set([
  'a',
  'add',
  'an',
  'buy',
  'cart',
  'find',
  'get',
  'in',
  'into',
  'item',
  'kar',
  'kardo',
  'ko',
  'me',
  'mein',
  'my',
  'please',
  'search',
  'the',
  'to',
]);

type GroceryOption = {
  offerId: string;
  priceAmount: number;
  priceCurrency: 'INR';
  product: string;
  price: string;
  size?: string;
  spokenLabel: string;
};

type CartReview = NonNullable<
  Awaited<ReturnType<BlinkitAndroidDriver['inspectCart']>>
>;

type BlinkitDriverPort = Pick<
  BlinkitAndroidDriver,
  | 'currentScreen'
  | 'inspectCart'
  | 'inspectCartPreservingVisibleOffer'
  | 'clickFinalOrderOnce'
  | 'prepareExistingCheckout'
  | 'readCheckoutReview'
  | 'readConfirmation'
  | 'readOrderHistory'
  | 'removeExistingCartItem'
  | 'search'
  | 'setExistingCartItemQuantity'
  | 'upsertVisibleCartItem'
  | 'upsertCartItem'
>;

type ReversibleBlinkitOperation =
  | 'add_cart_item'
  | 'confirm_order'
  | 'inspect_cart'
  | 'prepare_checkout'
  | 'remove_cart_item'
  | 'search_products'
  | 'set_cart_item_quantity';

type ReversibleExecutionStage =
  | 'device'
  | 'inspection'
  | 'input'
  | 'matching'
  | 'mutation'
  | 'recovery'
  | 'search'
  | 'verification';

type ReversibleFailureReason =
  | 'cart_inspection_failed'
  | 'device_unavailable'
  | 'invalid_product'
  | 'invalid_quantity'
  | 'mutation_failed'
  | 'offer_not_found'
  | 'search_failed'
  | 'session_recovery_failed'
  | 'verification_failed';

type ReversibleExecutionFailure = {
  failure: {
    operation: ReversibleBlinkitOperation;
    reason: ReversibleFailureReason;
    recoverable: boolean;
    stage: ReversibleExecutionStage;
  };
  ok: false;
  status: 'execution_failed';
  verification?: ProductMutationVerification;
};

type ReversibleExecutionStatus =
  | 'added'
  | 'already_in_cart'
  | 'cart_empty'
  | 'cart_status'
  | 'checkout_changed'
  | 'checkout_expired'
  | 'confirmation_required'
  | 'final_dispatch_disabled'
  | 'needs_clarification'
  | 'not_found'
  | 'order_status_ambiguous'
  | 'ordered'
  | 'quantity_updated'
  | 'reselection_required'
  | 'removed'
  | 'search_results';

type ReversibleExecutionResult =
  | ReversibleExecutionFailure
  | {
      ok: boolean;
      status: ReversibleExecutionStatus;
      [key: string]: unknown;
    };

type BlinkitExecutionServiceDependencies = {
  appiumSessionPool?: AppiumSessionPool<AppiumHttpClient>;
  commitStore?: AndroidCommitStore;
  createDriver?: (client: AppiumHttpClient) => BlinkitDriverPort;
  isDeviceReady?: () => Promise<boolean>;
  liveCommitEnabled?: boolean;
  now?: () => Date;
  nowMs?: () => number;
  openClient?: () => Promise<AppiumHttpClient>;
  proposalTtlMs?: number;
  publishStatus?: typeof publishOverlayStatus;
  recordSubstageMetric?: (metric: BlinkitExecutionSubstageMetric) => void;
  sessionDeviceKey?: string;
  statusPublishTimeoutMs?: number;
};

type BlinkitExecutionSubstage =
  | 'add_control_discovery'
  | 'candidate_extraction'
  | 'cart_inspection'
  | 'local_verification'
  | 'mutation'
  | 'reconciliation'
  | 'screen_recognition'
  | 'search_entry'
  | 'session_acquisition';

export type BlinkitExecutionSubstageMetric = {
  durationMs: number;
  healthCheckDurationMs?: number;
  itemId?: string;
  operationId?: string;
  outcome: 'completed' | 'error';
  recreationReason?: string;
  sessionCreationDurationMs?: number;
  sessionRecreated?: boolean;
  sessionReused?: boolean;
  stepId?: string;
  substage: BlinkitExecutionSubstage;
  taskId?: string;
  version: 1;
};

type FinishBlinkitExecutionSubstage = (
  outcome?: BlinkitExecutionSubstageMetric['outcome'],
  session?: Pick<
    BlinkitExecutionSubstageMetric,
    | 'healthCheckDurationMs'
    | 'recreationReason'
    | 'sessionCreationDurationMs'
    | 'sessionRecreated'
    | 'sessionReused'
  >,
) => void;

class ReversibleExecutionError extends Error {
  public constructor(
    public readonly stage: ReversibleExecutionStage,
    public readonly reason: ReversibleFailureReason,
    public readonly recoverable: boolean,
    options?: ErrorOptions,
  ) {
    super(`${stage}:${reason}`, options);
    this.name = 'ReversibleExecutionError';
  }
}

function normalizedWords(value: string): string[] {
  return value
    .toLocaleLowerCase('en-IN')
    .replace(/\blay['’]?s\b|\blayers\b/g, 'lays')
    .replace(/\bdoodh\b|\bdudh\b/g, 'milk')
    .replace(/\btazaa\b/g, 'taaza')
    .replace(/\bgrams?\b/g, 'g')
    .replace(/\bkilograms?\b|\bkgs?\b/g, 'kg')
    .replace(/\bmillilit(?:er|re)s?\b|\bmls?\b/g, 'ml')
    .replace(/\blitres?\b|\bliters?\b/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignoredRequestWords.has(word));
}

function offerWords(offer: AndroidSearchOffer): Set<string> {
  return new Set(normalizedWords(`${offer.title} ${offer.packSize ?? ''}`));
}

function formattedPrice(offer: AndroidSearchOffer): string {
  return new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(offer.price.amount);
}

function formattedAmount(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(amount);
}

export function cartItemFingerprint(
  cart: {
    lines: readonly {
      lineTotal: { amount: number; currency: string };
      name: string;
      productId: string;
      quantity: number;
      unitPrice: { amount: number; currency: string };
    }[];
    subtotal: { amount: number; currency: string };
    unavailableItems: readonly { query: string; reason: string }[];
  },
): string {
  const material = {
    lines: cart.lines
      .map((line) => ({
        lineTotal: line.lineTotal,
        name: line.name,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      }))
      .sort((left, right) => left.productId.localeCompare(right.productId)),
    subtotal: cart.subtotal,
    unavailableItems: [...cart.unavailableItems]
      .sort((left, right) => left.query.localeCompare(right.query)),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function cartResult(cart: CartReview) {
  const labels = buildProductSpokenLabels(cart.lines.map((line) => ({
    offerId: line.productId,
    title: line.name,
  })));
  return {
    addressLabel: cart.addressLabel,
    fingerprint: cart.providerFingerprint,
    itemFingerprint: cartItemFingerprint(cart),
    lines: cart.lines.map((line) => ({
      productId: line.productId,
      product: line.name,
      spokenLabel: labels.get(line.productId) ?? line.name,
      quantity: line.quantity,
      price: formattedAmount(line.unitPrice.amount),
    })),
    subtotal: formattedAmount(cart.subtotal.amount),
  };
}

function retainedPostCartInspection(
  cart: CartReview,
): NonNullable<ProductMutationVerification['postCart']> {
  if (cart.lines.length === 0) {
    return {
      ok: true,
      status: 'cart_empty',
    };
  }
  return {
    cart: {
      lines: cart.lines.map((line) => ({
        productId: line.productId,
        product: line.name,
        quantity: line.quantity,
        price: formattedAmount(line.unitPrice.amount),
      })),
    },
    ok: true,
    status: 'cart_status',
  };
}

function otherLinesUnchanged(
  before: CartReview,
  after: CartReview | undefined,
  targetProductId: string,
): boolean {
  return cartLinesEqual(
    before.lines.filter((line) => line.productId !== targetProductId),
    after?.lines.filter((line) => line.productId !== targetProductId) ?? [],
  );
}

function cartLinesEqual(
  before: readonly CartReview['lines'][number][],
  after: readonly CartReview['lines'][number][],
): boolean {
  const stableLines = (lines: readonly CartReview['lines'][number][]) => lines
    .map((line) => ({
      lineTotal: line.lineTotal,
      name: line.name,
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  return JSON.stringify(stableLines(before)) === JSON.stringify(stableLines(after));
}

function optionsFor(offers: readonly AndroidSearchOffer[]): GroceryOption[] {
  const uniqueOffers = distinctProviderOffers(offers);
  const labels = buildProductSpokenLabels(uniqueOffers);
  return uniqueOffers.map((offer) => ({
    offerId: offer.offerId,
    priceAmount: offer.price.amount,
    priceCurrency: offer.price.currency,
    product: offer.title,
    price: formattedPrice(offer),
    spokenLabel: labels.get(offer.offerId) ?? offer.title,
    ...(offer.packSize ? { size: offer.packSize } : {}),
  }));
}

function optionFor(
  offer: AndroidSearchOffer,
  offers: readonly AndroidSearchOffer[],
): GroceryOption {
  const label = buildProductSpokenLabels(offers).get(offer.offerId) ?? offer.title;
  return {
    offerId: offer.offerId,
    priceAmount: offer.price.amount,
    priceCurrency: offer.price.currency,
    product: offer.title,
    price: formattedPrice(offer),
    spokenLabel: label,
    ...(offer.packSize ? { size: offer.packSize } : {}),
  };
}

function normalizedIdentityText(value: string | undefined): string {
  return normalizedWords(value ?? '').join(' ');
}

function reconcileSelectedCartLine(
  offer: AndroidSearchOffer,
  lines: readonly CartReview['lines'][number][],
) {
  return reconcileProviderProductIdentity(
    {
      provider: 'blinkit',
      offerId: offer.offerId,
      packSize: offer.packSize,
      price: offer.price,
      title: offer.title,
    },
    lines.map((line) => {
      const extended = line as typeof line & {
        packSize?: unknown;
        size?: unknown;
      };
      return {
        line,
        productId: line.productId,
        provider: 'blinkit',
        price: line.unitPrice,
        title: line.name,
        ...(typeof extended.packSize === 'string'
          ? { packSize: extended.packSize }
          : typeof extended.size === 'string'
            ? { packSize: extended.size }
            : {}),
      };
    }),
  );
}

function retainedIdentityEvidence(
  expected: AndroidSearchOffer,
  reconciliation: ReturnType<typeof reconcileSelectedCartLine> | undefined,
  lines: readonly CartReview['lines'][number][],
): Pick<ProductMutationVerification, 'conflicts' | 'identityResolution'> {
  if (!reconciliation) return {};
  const conflicts = reconciliation.evidence.flatMap((candidate) =>
    candidate.anchors.length === 0
      ? []
      : candidate.comparisons.flatMap((comparison) => {
      if (
        comparison.outcome !== 'conflict'
        || !['packSize', 'price'].includes(comparison.field)
        || !comparison.expected
        || !comparison.observed
      ) {
        return [];
      }
      const observedLine = lines[candidate.candidateIndex];
      const extended = observedLine as typeof observedLine & {
        packSize?: unknown;
        size?: unknown;
      };
      const observedPack = typeof extended?.packSize === 'string'
        ? extended.packSize
        : typeof extended?.size === 'string'
          ? extended.size
          : comparison.observed;
      return [{
        field: comparison.field === 'packSize'
          ? 'pack_size' as const
          : 'price' as const,
        expected: (
          comparison.field === 'packSize'
            ? expected.packSize ?? comparison.expected
            : formattedPrice(expected)
        ).slice(0, 100),
        observed: (
          comparison.field === 'packSize'
            ? observedPack
            : observedLine
              ? formattedAmount(observedLine.unitPrice.amount)
              : comparison.observed
        ).slice(0, 100),
      }];
      })).slice(0, 4);
  return {
    identityResolution:
      reconciliation.status === 'ambiguous' || conflicts.length > 0
        ? 'ambiguous'
        : reconciliation.status,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

function cartLineMatchesOffer(
  offer: AndroidSearchOffer,
  line: CartReview['lines'][number],
): boolean {
  return reconcileSelectedCartLine(offer, [line]).status === 'unique';
}

function providerOfferSignature(offer: AndroidSearchOffer): string {
  return JSON.stringify({
    available: offer.available,
    offerId: offer.offerId,
    packSize: normalizedIdentityText(offer.packSize),
    priceAmount: Math.round(offer.price.amount * 100),
    priceCurrency: offer.price.currency,
    title: normalizedIdentityText(offer.title),
  });
}

function distinctProviderOffers(
  offers: readonly AndroidSearchOffer[],
): AndroidSearchOffer[] {
  const seen = new Set<string>();
  return offers.filter((offer) => {
    const signature = providerOfferSignature(offer);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function selectExactOffer(
  request: string,
  offers: readonly AndroidSearchOffer[],
  requestedOfferId?: string,
): AndroidSearchOffer | undefined {
  const available = distinctProviderOffers(
    offers.filter((offer) => offer.available),
  );
  if (requestedOfferId) {
    const selected = available.filter((offer) => offer.offerId === requestedOfferId);
    return selected.length === 1 ? selected[0] : undefined;
  }

  const wanted = normalizedWords(request);
  if (wanted.length === 0) return undefined;
  const matching = available.filter((offer) => {
    const words = offerWords(offer);
    return wanted.every((word) => words.has(word));
  });
  return matching.length === 1 ? matching[0] : undefined;
}

function validQuantity(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 20;
}

export async function readCurrentScreenEvidence(
  driver: Pick<BlinkitAndroidDriver, 'currentScreen'>,
): Promise<CurrentScreenEvidence | undefined> {
  try {
    return {
      observedAfterAction: true,
      screen: await driver.currentScreen(),
    };
  } catch {
    return undefined;
  }
}

function executionFailure(
  operation: ReversibleBlinkitOperation,
  stage: ReversibleExecutionStage,
  reason: ReversibleFailureReason,
  recoverable: boolean,
  verification?: ProductMutationVerification,
): ReversibleExecutionFailure {
  return {
    failure: {
      operation,
      reason,
      recoverable,
      stage,
    },
    ok: false,
    status: 'execution_failed',
    ...(verification ? { verification } : {}),
  };
}

function mutationError(error: unknown): ReversibleExecutionError {
  const message = error instanceof Error ? error.message : '';
  return /verify|preservation/i.test(message)
    ? new ReversibleExecutionError(
        'verification',
        'verification_failed',
        true,
        { cause: error },
      )
    : new ReversibleExecutionError(
        'mutation',
        'mutation_failed',
        true,
        { cause: error },
      );
}

export class BlinkitExecutionService {
  private readonly createDriver: (client: AppiumHttpClient) => BlinkitDriverPort;
  private readonly commitStore: AndroidCommitStore;
  private readonly isDeviceReady: () => Promise<boolean>;
  private readonly liveCommitEnabled: boolean;
  private readonly now: () => Date;
  private readonly nowMs: () => number;
  private readonly openClient: () => Promise<AppiumHttpClient>;
  private readonly appiumSessionPool?: AppiumSessionPool<AppiumHttpClient>;
  private readonly proposalTtlMs: number;
  private readonly publishStatus: typeof publishOverlayStatus;
  private readonly recordSubstageMetric: (
    metric: BlinkitExecutionSubstageMetric,
  ) => void;
  private readonly sessionDeviceKey: string;
  private readonly statusPublishTimeoutMs: number;
  private statusPublicationTail: Promise<void> = Promise.resolve();

  public constructor(dependencies: BlinkitExecutionServiceDependencies = {}) {
    this.commitStore = dependencies.commitStore
      ?? new FileAndroidCommitStore(
        process.env.ERRANDOS_CHECKOUT_STATE_DIR
          ?? join(process.cwd(), '.runtime', 'checkout-commits'),
      );
    this.createDriver = dependencies.createDriver
      ?? ((client) => new BlinkitAndroidDriver(client));
    this.isDeviceReady = dependencies.isDeviceReady
      ?? (() => AppiumHttpClient.isReady({
        endpoint: APPIUM_URL,
      }));
    this.openClient = dependencies.openClient
      ?? (() => AppiumHttpClient.open({
        appPackage: BLINKIT_PACKAGE,
        endpoint: APPIUM_URL,
        ...(DEVICE_UDID ? { udid: DEVICE_UDID } : {}),
      }));
    this.appiumSessionPool = dependencies.appiumSessionPool
      ?? (dependencies.openClient
        ? undefined
        : blinkitAppiumSessionPool());
    this.sessionDeviceKey = dependencies.sessionDeviceKey
      ?? DEVICE_UDID
      ?? BLINKIT_APPIUM_DEVICE_KEY;
    this.liveCommitEnabled = dependencies.liveCommitEnabled
      ?? process.env.ERRANDOS_LIVE_COMMIT === 'true';
    this.now = dependencies.now ?? (() => new Date());
    this.nowMs = dependencies.nowMs ?? (() => performance.now());
    this.proposalTtlMs = dependencies.proposalTtlMs ?? 5 * 60_000;
    this.publishStatus = dependencies.publishStatus
      ?? (process.env.NODE_ENV === 'test'
        ? async (): Promise<boolean> => false
        : publishOverlayStatus);
    this.statusPublishTimeoutMs = dependencies.statusPublishTimeoutMs ?? 1_500;
    if (
      !Number.isSafeInteger(this.statusPublishTimeoutMs)
      || this.statusPublishTimeoutMs < 1
      || this.statusPublishTimeoutMs > 10_000
    ) {
      throw new Error(
        'Status publication timeout must be an integer between 1 and 10000 milliseconds',
      );
    }
    this.recordSubstageMetric = dependencies.recordSubstageMetric
      ?? ((metric) => logEvent('info', 'metric.phone_substage', metric));
  }

  private beginSubstage(
    substage: BlinkitExecutionSubstage,
    control?: PhoneOperationExecutionControl,
  ): FinishBlinkitExecutionSubstage {
    const startedAt = this.nowMs();
    const operation = control?.current();
    let finished = false;
    return (outcome = 'completed', session = {}) => {
      if (finished) return;
      finished = true;
      const itemId = operation?.itemId;
      this.recordSubstageMetric({
        durationMs: Math.max(0, Math.round(this.nowMs() - startedAt)),
        outcome,
        substage,
        version: 1,
        ...(operation?.operationId
          ? { operationId: operation.operationId }
          : {}),
        ...(operation?.taskId ? { taskId: operation.taskId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(operation?.stepId ? { stepId: operation.stepId } : {}),
        ...session,
      });
    };
  }

  private async currentScreenEvidence(
    driver: Pick<BlinkitAndroidDriver, 'currentScreen'>,
    control?: PhoneOperationExecutionControl,
  ): Promise<CurrentScreenEvidence | undefined> {
    const finish = this.beginSubstage('screen_recognition', control);
    try {
      const evidence = await readCurrentScreenEvidence(driver);
      finish(evidence ? 'completed' : 'error');
      return evidence;
    } catch (error) {
      finish('error');
      throw error;
    }
  }

  private status(
    text: string,
    state: Parameters<typeof publishOverlayStatus>[1],
    control?: PhoneOperationExecutionControl,
    _stage?: OverlayTaskProgressStageV1,
  ): void {
    if (control && !control.isCurrent()) return;
    void _stage;
    this.statusPublicationTail = this.statusPublicationTail.then(async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const publication = Promise.resolve()
        .then(() => this.publishStatus(text, state))
        .then(
          (published) => ({
            kind: published ? 'published' : 'unavailable',
          } as const),
          (error: unknown) => ({ kind: 'failed', error } as const),
        );
      const timeout = new Promise<{ kind: 'timed_out' }>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ kind: 'timed_out' }),
          this.statusPublishTimeoutMs,
        );
        timeoutHandle.unref?.();
      });
      const outcome = await Promise.race([publication, timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (outcome.kind === 'published') return;
      logEvent('warn', `blinkit.overlay_status.${outcome.kind}`, {
        state,
        ...(outcome.kind === 'failed'
          ? errorDetails(outcome.error)
          : outcome.kind === 'timed_out'
            ? { timeoutMs: this.statusPublishTimeoutMs }
            : {}),
      });
    }).catch((error: unknown) => {
      logEvent('warn', 'blinkit.overlay_status.dispatch_failed', {
        state,
        ...errorDetails(error),
      });
    });
  }

  private async openDriver(): Promise<{
    client: AppiumHttpClient;
    driver: BlinkitDriverPort;
    sessionRecovered: boolean;
  }> {
    try {
      const client = await this.openClient();
      return {
        client,
        driver: this.createDriver(client),
        sessionRecovered: false,
      };
    } catch (firstError) {
      let ready = false;
      try {
        ready = await this.isDeviceReady();
      } catch {
        ready = false;
      }
      if (!ready) {
        throw new ReversibleExecutionError(
          'device',
          'device_unavailable',
          true,
          { cause: firstError },
        );
      }
      try {
        const client = await this.openClient();
        return {
          client,
          driver: this.createDriver(client),
          sessionRecovered: true,
        };
      } catch (recoveryError) {
        throw new ReversibleExecutionError(
          'recovery',
          'session_recovery_failed',
          true,
          { cause: recoveryError },
        );
      }
    }
  }

  private async execute<T extends ReversibleExecutionResult>(
    operation: ReversibleBlinkitOperation,
    work: (driver: BlinkitDriverPort) => Promise<T>,
    control?: PhoneOperationExecutionControl,
  ): Promise<T | ReversibleExecutionFailure> {
    let client: AppiumHttpClient | undefined;
    const currentOperation = control?.current();
    const metricIds = {
      ...(currentOperation?.operationId
        ? { operationId: currentOperation.operationId }
        : {}),
      ...(currentOperation?.taskId
        ? { taskId: currentOperation.taskId }
        : {}),
      ...(currentOperation?.itemId
        ? { itemId: currentOperation.itemId }
        : {}),
    };
    const sessionTimer = stageMetrics.begin('device_session', metricIds);
    const finishSessionAcquisition = this.beginSubstage(
      'session_acquisition',
      control,
    );
    let sessionMetricFinished = false;
    try {
      control?.checkpoint('cancelled before opening phone session');
      if (this.appiumSessionPool) {
        return await this.appiumSessionPool.withSession(
          this.sessionDeviceKey,
          async (pooledClient, acquisition) => {
            finishSessionAcquisition('completed', {
              ...(acquisition.healthCheckDurationMs !== undefined
                ? { healthCheckDurationMs: acquisition.healthCheckDurationMs }
                : {}),
              ...(acquisition.recreationReason
                ? { recreationReason: acquisition.recreationReason }
                : {}),
              ...(acquisition.sessionCreationDurationMs !== undefined
                ? {
                    sessionCreationDurationMs:
                      acquisition.sessionCreationDurationMs,
                  }
                : {}),
              sessionRecreated: acquisition.sessionRecreated,
              sessionReused: acquisition.sessionReused,
            });
            logEvent('info', 'metric.stage', sessionTimer.finish({
              outcome: 'completed',
            }));
            sessionMetricFinished = true;
            control?.checkpoint('cancelled after opening phone session');
            const result = await work(this.createDriver(pooledClient));
            return {
              ...result,
              execution: {
                sessionRecovered: acquisition.sessionRecreated,
                sessionReused: acquisition.sessionReused,
              },
            };
          },
        );
      }
      const opened = await this.openDriver();
      finishSessionAcquisition('completed', {
        sessionRecreated: opened.sessionRecovered,
        sessionReused: false,
      });
      logEvent('info', 'metric.stage', sessionTimer.finish({
        outcome: 'completed',
      }));
      sessionMetricFinished = true;
      client = opened.client;
      control?.checkpoint('cancelled after opening phone session');
      const result = await work(opened.driver);
      return opened.sessionRecovered
        ? {
            ...result,
            execution: { sessionRecovered: true },
          }
        : result;
    } catch (error) {
      if (!sessionMetricFinished) {
        finishSessionAcquisition('error');
        const cancelled = error instanceof PhoneOperationCancelledError;
        logEvent(cancelled ? 'info' : 'warn', 'metric.stage', sessionTimer.finish({
          fallbackReason: cancelled
            ? 'cancelled'
            : error instanceof ReversibleExecutionError
                && error.reason === 'device_unavailable'
              ? 'device_unavailable'
              : error instanceof ReversibleExecutionError
                  && error.reason === 'session_recovery_failed'
                ? 'session_recovery_failed'
                : 'function_error',
          outcome: cancelled ? 'cancelled' : 'error',
        }));
      }
      if (error instanceof PhoneOperationCancelledError) throw error;
      const failure = error instanceof ReversibleExecutionError
        ? error
        : new ReversibleExecutionError(
            'recovery',
            'session_recovery_failed',
            true,
            { cause: error },
          );
      logEvent('warn', 'phone.execution.failed', {
        operation,
        reason: failure.reason,
        recoverable: failure.recoverable,
        stage: failure.stage,
        ...errorDetails(error),
      });
      await this.status(
        'Phone execution needs attention',
        'error',
        control,
        'failed',
      );
      return executionFailure(
        operation,
        failure.stage,
        failure.reason,
        failure.recoverable,
      );
    } finally {
      try {
        await client?.close();
      } catch {
        // A completed operation remains completed even when session cleanup fails.
      }
    }
  }

  public async searchProducts(
    request: string,
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    const searchQuery = request.trim();
    if (!searchQuery) {
      return executionFailure(
        'search_products',
        'input',
        'invalid_product',
        false,
      );
    }

    await this.status(
      `Searching for ${searchQuery}`,
      'searching',
      control,
      'searching',
    );
    return this.execute('search_products', async (driver) => {
      let offers: AndroidSearchOffer[];
      const searchTimer = stageMetrics.begin('provider_search', {
        ...(control?.operationId
          ? { operationId: control.operationId }
          : {}),
      });
      const finishSearchEntry = this.beginSubstage('search_entry', control);
      try {
        control?.checkpoint('cancelled before product search');
        offers = await driver.search(searchQuery, 10);
        finishSearchEntry();
        logEvent('info', 'metric.stage', searchTimer.finish({
          outcome: 'completed',
        }));
        control?.checkpoint('cancelled after product search');
      } catch (error) {
        finishSearchEntry('error');
        logEvent('warn', 'metric.stage', searchTimer.finish({
          fallbackReason: error instanceof PhoneOperationCancelledError
            ? 'cancelled'
            : 'provider_error',
          outcome: error instanceof PhoneOperationCancelledError
            ? 'cancelled'
            : 'error',
        }));
        throw new ReversibleExecutionError(
          'search',
          'search_failed',
          true,
          { cause: error },
        );
      }
      const screenEvidence = await this.currentScreenEvidence(driver, control);
      const finishCandidateExtraction = this.beginSubstage(
        'candidate_extraction',
        control,
      );
      const available = offers.filter((offer) => offer.available).slice(0, 5);
      const options = optionsFor(available);
      finishCandidateExtraction();
      if (available.length === 0) {
        await this.status(
          `No result for ${searchQuery}`,
          'clarification',
          control,
          'waiting_for_choice',
        );
        return {
          ok: false,
          request: searchQuery,
          status: 'not_found',
          ...(screenEvidence ? { screenEvidence } : {}),
        };
      }

      await this.status(
        `Found ${options.length} option${options.length === 1 ? '' : 's'}`,
        'clarification',
        control,
        'waiting_for_choice',
      );
      return {
        ok: true,
        options,
        request: searchQuery,
        speakPrice: /\b(price|cost|how much|rate|kitna|kitne|daam)\b/i.test(searchQuery),
        status: 'search_results',
        ...(screenEvidence ? { screenEvidence } : {}),
      };
    }, control);
  }

  public async inspectCart(
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    return this.inspectCartWith(
      (driver) => driver.inspectCart(),
      control,
    );
  }

  public async inspectCartForMutationBaseline(
    selectedOffer: SelectedProductOffer,
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    const offer: AndroidSearchOffer = {
      available: true,
      offerId: selectedOffer.offerId,
      ...(selectedOffer.packSize
        ? { packSize: selectedOffer.packSize }
        : {}),
      price: {
        amount: selectedOffer.priceAmount,
        currency: selectedOffer.priceCurrency,
      },
      title: selectedOffer.title,
    };
    return this.inspectCartWith(
      (driver) => driver.inspectCartPreservingVisibleOffer(offer),
      control,
    );
  }

  private async inspectCartWith(
    inspect: (driver: BlinkitDriverPort) => Promise<CartReview | undefined>,
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    await this.status('Checking your cart', 'working', control, 'verifying');
    return this.execute('inspect_cart', async (driver) => {
      let cart: CartReview | undefined;
      const finishCartInspection = this.beginSubstage(
        'cart_inspection',
        control,
      );
      try {
        control?.checkpoint('cancelled before cart inspection');
        cart = await inspect(driver);
        finishCartInspection();
        control?.checkpoint('cancelled after cart inspection');
      } catch (error) {
        finishCartInspection('error');
        throw new ReversibleExecutionError(
          'inspection',
          'cart_inspection_failed',
          true,
          { cause: error },
        );
      }
      const screenEvidence = await this.currentScreenEvidence(driver, control);
      if (!cart) {
        await this.status('Cart is empty', 'ready', control, 'completed');
        return {
          ok: true,
          status: 'cart_empty',
          ...(screenEvidence ? { screenEvidence } : {}),
        };
      }

      const presentedCart = cartResult(cart);
      await this.status(
        `${presentedCart.lines.length} cart item${presentedCart.lines.length === 1 ? '' : 's'}`,
        'ready',
        control,
        'completed',
      );
      return {
        cart: presentedCart,
        ok: true,
        status: 'cart_status',
        ...(screenEvidence ? { screenEvidence } : {}),
      };
    }, control);
  }

  public async prepareCheckout(
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    await this.status(
      'Reading exact checkout terms',
      'checkout',
      control,
      'verifying',
    );
    return this.execute('prepare_checkout', async (driver) => {
      let checkout: AndroidCheckoutReviewV1;
      try {
        control?.checkpoint('cancelled before checkout preparation');
        checkout = await driver.prepareExistingCheckout();
        control?.checkpoint('cancelled after checkout preparation');
      } catch (error) {
        throw new ReversibleExecutionError(
          'inspection',
          'cart_inspection_failed',
          true,
          { cause: error },
        );
      }
      let proposal: CodCheckoutProposalV1;
      try {
        proposal = buildCodCheckoutProposal(
          checkout,
          this.now(),
          this.proposalTtlMs,
        );
      } catch (error) {
        throw new ReversibleExecutionError(
          'verification',
          'verification_failed',
          false,
          { cause: error },
        );
      }
      const screenEvidence = await this.currentScreenEvidence(driver, control);
      await this.status(
        'Checkout ready for review · NOT ORDERED',
        'confirmation',
        control,
        'waiting_for_choice',
      );
      return {
        checkout: proposal,
        confirmationPhrase: 'Confirm COD order',
        message: 'Review these exact terms. Nothing has been ordered.',
        ok: false,
        status: 'confirmation_required',
        ...(screenEvidence ? { screenEvidence } : {}),
      };
    }, control);
  }

  public async confirmCheckout(
    proposal: CodCheckoutProposalV1 | undefined,
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    if (!proposal) {
      return {
        ok: false,
        status: 'confirmation_required',
        message: 'Prepare and review a fresh checkout first.',
      };
    }
    if (this.now().getTime() > Date.parse(proposal.expiresAt)) {
      return {
        changes: ['expiry'],
        ok: false,
        status: 'checkout_expired',
        message: 'The reviewed checkout expired. Prepare it again.',
      };
    }
    if (!this.liveCommitEnabled) {
      return {
        ok: false,
        status: 'final_dispatch_disabled',
        message: 'Final order dispatch is disabled. Nothing was ordered.',
      };
    }

    await this.status(
      'Revalidating exact checkout terms',
      'checkout',
      control,
      'verifying',
    );
    return this.execute('confirm_order', async (driver) => {
      let current: AndroidCheckoutReviewV1;
      try {
        current = await driver.readCheckoutReview(
          proposal.checkout.addressReference,
          proposal.checkout.addressLabel,
          proposal.checkout,
        );
      } catch (error) {
        throw new ReversibleExecutionError(
          'inspection',
          'cart_inspection_failed',
          true,
          { cause: error },
        );
      }
      const changes = checkoutTermChanges(proposal.checkout, current);
      if (changes.length > 0) {
        await this.status(
          'Checkout changed · NOT ORDERED',
          'confirmation',
          control,
          'waiting_for_choice',
        );
        return {
          changes,
          currentProviderFingerprint: current.providerFingerprint,
          ok: false,
          status: 'checkout_changed',
          message: 'Checkout terms changed. Review and confirm a fresh proposal.',
        };
      }

      const expected: AndroidExpectedCheckoutV1 = {
        checkout: proposal.checkout,
        expiresAt: proposal.expiresAt,
        idempotencyKey: proposal.idempotencyKey,
        preparedAt: proposal.preparedAt,
        proposalHash: proposal.proposalHash,
        proposalId: proposal.proposalId,
      };
      const result = await commitOnce(expected, {
        clickFinal: async () => {
          control?.markFinalDispatchAttempted(
            'durable dispatch reserved; final provider action starting',
          );
          await driver.clickFinalOrderOnce();
        },
        now: this.now,
        readCheckout: async () => current,
        readConfirmation: () => driver.readConfirmation(),
        store: this.commitStore,
      });
      if (result.outcome === 'stale') {
        return {
          changes: ['expiry'],
          ok: false,
          status: 'checkout_expired',
          message: 'The reviewed checkout expired. Prepare it again.',
        };
      }
      if (result.outcome === 'committed') {
        await this.status(
          'COD order confirmed',
          'success',
          control,
          'completed',
        );
        return {
          ok: true,
          providerReference: result.providerReference,
          status: 'ordered',
        };
      }

      control?.markReconciling('reading order history after uncertain dispatch');
      try {
        const reconciled = await reconcileFromOrderHistory(expected, {
          readOrders: () => driver.readOrderHistory(expected),
        });
        if (reconciled.outcome === 'committed') {
          await this.commitStore.recordOutcome(
            expected.idempotencyKey,
            'committed',
            reconciled.providerReference,
          );
          await this.status(
            'COD order confirmed',
            'success',
            control,
            'completed',
          );
          return {
            ok: true,
            providerReference: reconciled.providerReference,
            reconciled: true,
            status: 'ordered',
          };
        }
      } catch {
        // Unknown final outcomes remain ambiguous when read-only reconciliation
        // cannot establish one unique provider order.
      }
      await this.status(
        'Final status is uncertain · do not retry',
        'error',
        control,
        'ambiguous',
      );
      return {
        ok: false,
        reconciliationRequired: true,
        status: 'order_status_ambiguous',
        message: 'The final action may have happened. Do not retry it.',
      };
    }, control);
  }

  public async addCartItem(input: {
    offerId?: string;
    quantity: number;
    reconcileOnly?: boolean;
    request: string;
    searchQuery?: string;
    selectedOffer?: SelectedProductOffer;
  }, control?: PhoneOperationExecutionControl): Promise<ReversibleExecutionResult> {
    const spokenRequest = input.request.trim();
    const searchQuery = input.searchQuery?.trim() || spokenRequest;
    if (!spokenRequest || !searchQuery) {
      return executionFailure(
        'add_cart_item',
        'input',
        'invalid_product',
        false,
      );
    }
    if (!validQuantity(input.quantity)) {
      return executionFailure(
        'add_cart_item',
        'input',
        'invalid_quantity',
        false,
      );
    }

    await this.status(
      input.selectedOffer
        ? `Using selected ${input.selectedOffer.title}`
        : `Searching for ${searchQuery}`,
      input.selectedOffer ? 'working' : 'searching',
      control,
      input.selectedOffer ? 'adding' : 'searching',
    );
    return this.execute('add_cart_item', async (driver) => {
      let offers: AndroidSearchOffer[];
      if (input.selectedOffer) {
        offers = [{
          available: true,
          offerId: input.selectedOffer.offerId,
          ...(input.selectedOffer.packSize
            ? { packSize: input.selectedOffer.packSize }
            : {}),
          price: {
            amount: input.selectedOffer.priceAmount,
            currency: input.selectedOffer.priceCurrency,
          },
          title: input.selectedOffer.title,
        }];
      } else {
        const searchTimer = stageMetrics.begin('provider_search', {
          ...(control?.operationId
            ? { operationId: control.operationId }
            : {}),
        });
        const finishSearchEntry = this.beginSubstage('search_entry', control);
        try {
          control?.checkpoint('cancelled before product search');
          offers = await driver.search(searchQuery, 10);
          finishSearchEntry();
          logEvent('info', 'metric.stage', searchTimer.finish({
            outcome: 'completed',
          }));
          control?.checkpoint('cancelled after product search');
        } catch (error) {
          finishSearchEntry('error');
          logEvent('warn', 'metric.stage', searchTimer.finish({
            fallbackReason: error instanceof PhoneOperationCancelledError
              ? 'cancelled'
              : 'provider_error',
            outcome: error instanceof PhoneOperationCancelledError
              ? 'cancelled'
              : 'error',
          }));
          throw new ReversibleExecutionError(
            'search',
            'search_failed',
            true,
            { cause: error },
          );
        }
      }
      const finishCandidateExtraction = this.beginSubstage(
        'candidate_extraction',
        control,
      );
      const availableOffers = offers.filter((offer) => offer.available);
      const selected = selectExactOffer(
        spokenRequest,
        offers,
        input.offerId,
      );
      finishCandidateExtraction();
      if (availableOffers.length === 0) {
        const screenEvidence = await this.currentScreenEvidence(driver, control);
        await this.status(
          `No result for ${searchQuery}`,
          'clarification',
          control,
          'waiting_for_choice',
        );
        return {
          ok: false,
          request: searchQuery,
          status: 'not_found',
          ...(screenEvidence ? { screenEvidence } : {}),
        };
      }

      if (!selected && input.offerId) {
        throw new ReversibleExecutionError(
          'matching',
          'offer_not_found',
          false,
        );
      }
      if (!selected) {
        const options = optionsFor(availableOffers.slice(0, 5));
        const screenEvidence = await this.currentScreenEvidence(driver, control);
        await this.status(
          'Product choice required',
          'clarification',
          control,
          'waiting_for_choice',
        );
        return {
          ok: false,
          options,
          quantity: input.quantity,
          request: searchQuery,
          status: 'needs_clarification',
          ...(screenEvidence ? { screenEvidence } : {}),
        };
      }

      const matchesSelected = (line: CartReview['lines'][number]) =>
        cartLineMatchesOffer(selected, line);
      const option = optionFor(selected, availableOffers);
      if (input.reconcileOnly) {
        control?.markReconciling('reconciling previously attempted mutation');
        await this.status(
          `Verifying ${option.spokenLabel} in cart`,
          'working',
          control,
          'reconciling',
        );
        let cart: CartReview | undefined;
        const finishReconciliation = this.beginSubstage(
          'reconciliation',
          control,
        );
        try {
          cart = await driver.inspectCart();
          finishReconciliation();
        } catch (error) {
          finishReconciliation('error');
          logEvent('warn', 'blinkit.add.reconciliation_failed', {
            ...errorDetails(error),
            offerId: selected.offerId,
            stage: 'inspection',
          });
          return executionFailure(
            'add_cart_item',
            'inspection',
            'cart_inspection_failed',
            true,
            {
              directControl: 'unknown',
              mutationAttempted: false,
              outcome: 'ambiguous',
              reconciliation: 'inspection_failed',
              unrelatedCartPreserved: null,
            },
          );
        }
        const selectedMatch = cart
          ? reconcileSelectedCartLine(selected, cart.lines)
          : undefined;
        const selectedLine = selectedMatch?.status === 'unique'
          ? selectedMatch.match.candidate.line
          : undefined;
        const identityEvidence = retainedIdentityEvidence(
          selected,
          selectedMatch,
          cart?.lines ?? [],
        );
        if (
          !cart
          || selectedMatch?.status !== 'unique'
          || selectedLine?.quantity !== input.quantity
        ) {
          logEvent('warn', 'blinkit.add.reconciliation_failed', {
            offerId: selected.offerId,
            observedLines: cart?.lines.map((line) => ({
              name: line.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
            })),
            stage: 'verification',
          });
          return executionFailure(
            'add_cart_item',
            'verification',
            'verification_failed',
            true,
            {
              ...(cart
                ? { afterItemFingerprint: cartItemFingerprint(cart) }
                : {}),
              directControl: 'unknown',
              ...identityEvidence,
              mutationAttempted: false,
              outcome: identityEvidence.identityResolution === 'ambiguous'
                ? 'ambiguous'
                : 'verified_no_change',
              reconciliation: 'mismatch',
              unrelatedCartPreserved: null,
            },
          );
        }
        const screenEvidence = await this.currentScreenEvidence(driver, control);
        await this.status(
          `${option.spokenLabel} already in cart`,
          'success',
          control,
          'completed',
        );
        return {
          cartFingerprint: cart?.providerFingerprint,
          ok: true,
          price: option.price,
          product: option.product,
          quantity: selectedLine.quantity,
          request: searchQuery,
          size: option.size,
          spokenLabel: option.spokenLabel,
          status: 'already_in_cart',
          verification: {
            afterItemFingerprint: cartItemFingerprint(cart),
            directControl: 'unknown',
            mutationAttempted: false,
            outcome: 'verified_success',
            reconciliation: 'verified',
            unrelatedCartPreserved: null,
          } satisfies ProductMutationVerification,
          ...(screenEvidence ? { screenEvidence } : {}),
        };
      }
      await this.status(
        `Adding ${option.spokenLabel}`,
        'adding',
        control,
        'adding',
      );
      let mutation: Awaited<ReturnType<BlinkitAndroidDriver['upsertVisibleCartItem']>>;
      const finishAddControlDiscovery = this.beginSubstage(
        'add_control_discovery',
        control,
      );
      let finishMutation: FinishBlinkitExecutionSubstage | undefined;
      let finishLocalVerification: FinishBlinkitExecutionSubstage | undefined;
      let finishCartInspection: FinishBlinkitExecutionSubstage | undefined;
      let mutationStarted = false;
      let ordinaryPostMutationInspections: 0 | 1 = 0;
      const shareInspectionEvidence = <Result extends object>(
        result: Result,
        cart?: CartReview,
      ): Result => attachSharedCartInspectionEvidenceV2(result, {
        ordinaryPostMutationInspections,
        ...(cart
          ? { inspection: retainedPostCartInspection(cart) }
          : {}),
      });
      try {
        mutation = await driver.upsertVisibleCartItem(
          selected,
          input.quantity,
          {
            onMutationStarted: async () => {
              await control?.markMutationAttemptedAtProviderBoundary(
                'cart mutation attempted',
              );
              mutationStarted = true;
              finishAddControlDiscovery();
              finishMutation = this.beginSubstage('mutation', control);
              finishLocalVerification = this.beginSubstage(
                'local_verification',
                control,
              );
            },
            onVerificationStarted: async () => {
              finishMutation?.();
              control?.markReconciling('verifying cart mutation');
              await this.status(
                `Verifying ${option.spokenLabel} in cart`,
                'working',
                control,
                'verifying',
              );
            },
            onCartInspectionStarted: () => {
              ordinaryPostMutationInspections = 1;
              finishLocalVerification?.();
              finishCartInspection = this.beginSubstage(
                'cart_inspection',
                control,
              );
            },
          },
        );
        finishCartInspection?.();
      } catch (error) {
        finishAddControlDiscovery('error');
        finishMutation?.('error');
        finishLocalVerification?.('error');
        finishCartInspection?.('error');
        if (
          !mutationStarted
          && error instanceof Error
          && /cart_item_offer failed/.test(error.message)
        ) {
          return shareInspectionEvidence({
            ok: false,
            request: searchQuery,
            status: 'reselection_required',
            verification: {
              directControl: 'unchanged',
              identityResolution: 'none',
              mutationAttempted: false,
              outcome: 'failed_before_mutation',
              reconciliation: 'not_run',
              unrelatedCartPreserved: null,
            } satisfies ProductMutationVerification,
          });
        }
        control?.markReconciling('reconciling uncertain cart mutation');
        await this.status(
          `Reconciling ${option.spokenLabel}`,
          'working',
          control,
          'reconciling',
        );
        logEvent('warn', 'blinkit.add.mutation_unverified', {
          ...errorDetails(error),
          offerId: selected.offerId,
        });
        const retainedVerification = error instanceof
          AndroidCartMutationVerificationError
          ? error
          : undefined;
        let reconciledCart: CartReview | undefined =
          retainedVerification?.observedCart;
        const directFailure = mutationError(error);
        const finishReconciliation = this.beginSubstage(
          'reconciliation',
          control,
        );
        try {
          if (!retainedVerification) {
            ordinaryPostMutationInspections = 1;
            reconciledCart = await driver.inspectCart();
          } else if (!reconciledCart) {
            throw retainedVerification.cause
              ?? new Error('post-mutation cart inspection failed');
          }
          finishReconciliation();
        } catch (inspectionError) {
          finishReconciliation('error');
          logEvent('warn', 'blinkit.add.reconciliation_failed', {
            ...errorDetails(inspectionError),
            offerId: selected.offerId,
            stage: 'inspection',
          });
          return shareInspectionEvidence(executionFailure(
            'add_cart_item',
            directFailure.stage,
            directFailure.reason,
            true,
            {
              directControl: 'unknown',
              mutationAttempted: mutationStarted,
              outcome: 'ambiguous',
              reconciliation: 'inspection_failed',
              unrelatedCartPreserved: null,
            },
          ));
        }
        const reconciledMatch = reconciledCart
          ? reconcileSelectedCartLine(selected, reconciledCart.lines)
          : undefined;
        const reconciledLine = reconciledMatch?.status === 'unique'
          ? reconciledMatch.match.candidate.line
          : undefined;
        const identityEvidence = retainedIdentityEvidence(
          selected,
          reconciledMatch,
          reconciledCart?.lines ?? [],
        );
        if (
          reconciledCart
          && reconciledMatch?.status === 'unique'
          && reconciledLine?.quantity === input.quantity
        ) {
          const screenEvidence = await this.currentScreenEvidence(driver, control);
          await this.status(
            `${option.spokenLabel} is in cart`,
            'success',
            control,
            'completed',
          );
          return shareInspectionEvidence({
            cartFingerprint: reconciledCart.providerFingerprint,
            ok: true,
            price: option.price,
            product: option.product,
            quantity: reconciledLine.quantity,
            request: searchQuery,
            size: option.size,
            spokenLabel: option.spokenLabel,
            status: 'already_in_cart',
            verification: {
              afterItemFingerprint: cartItemFingerprint(reconciledCart),
              directControl: 'unknown',
              ...identityEvidence,
              mutationAttempted: true,
              outcome: 'verified_success',
              postCart: retainedPostCartInspection(reconciledCart),
              reconciliation: 'verified',
              unrelatedCartPreserved: null,
            } satisfies ProductMutationVerification,
            ...(screenEvidence ? { screenEvidence } : {}),
          }, reconciledCart);
        }
        return shareInspectionEvidence(executionFailure(
          'add_cart_item',
          directFailure.stage,
          directFailure.reason,
          true,
          {
            ...(reconciledCart
              ? { afterItemFingerprint: cartItemFingerprint(reconciledCart) }
              : {}),
            directControl: 'unknown',
            ...identityEvidence,
            mutationAttempted: true,
            outcome: identityEvidence.identityResolution === 'ambiguous'
              ? 'ambiguous'
              : 'verified_no_change',
            ...(reconciledCart
              ? { postCart: retainedPostCartInspection(reconciledCart) }
              : {}),
            reconciliation: 'mismatch',
            unrelatedCartPreserved: null,
          },
        ), reconciledCart);
      }
      const { before: existingCart, cart, changed } = mutation;
      const selectedMatch = reconcileSelectedCartLine(selected, cart.lines);
      const selectedLine = selectedMatch.status === 'unique'
        ? selectedMatch.match.candidate.line
        : undefined;
      const identityEvidence = retainedIdentityEvidence(
        selected,
        selectedMatch,
        cart.lines,
      );
      const targetVerified = selectedMatch.status === 'unique'
        && selectedLine?.quantity === input.quantity;
      const unrelatedCartPreserved = existingCart
        ? cartLinesEqual(
            existingCart.lines.filter((line) => !matchesSelected(line)),
            cart.lines.filter((line) => !matchesSelected(line)),
          )
        : null;
      if (!targetVerified || unrelatedCartPreserved === false) {
        return shareInspectionEvidence(executionFailure(
          'add_cart_item',
          'verification',
          'verification_failed',
          true,
          {
            ...(existingCart
              ? { beforeItemFingerprint: cartItemFingerprint(existingCart) }
              : {}),
            afterItemFingerprint: cartItemFingerprint(cart),
            directControl: changed ? 'changed' : 'unchanged',
            ...identityEvidence,
            mutationAttempted: true,
            outcome: unrelatedCartPreserved === false
              || identityEvidence.identityResolution === 'ambiguous'
              ? 'ambiguous'
              : 'verified_no_change',
            postCart: retainedPostCartInspection(cart),
            reconciliation: 'mismatch',
            unrelatedCartPreserved,
          },
        ), cart);
      }
      const screenEvidence = await this.currentScreenEvidence(driver, control);
      await this.status(
        `${option.spokenLabel} ${changed ? 'added' : 'already in cart'}`,
        'success',
        control,
        'completed',
      );
      return shareInspectionEvidence({
        cartFingerprint: cart.providerFingerprint,
        ok: true,
        price: option.price,
        product: option.product,
        quantity: selectedLine!.quantity,
        request: searchQuery,
        size: option.size,
        spokenLabel: option.spokenLabel,
        status: changed ? 'added' : 'already_in_cart',
        verification: {
          ...(existingCart
            ? { beforeItemFingerprint: cartItemFingerprint(existingCart) }
            : {}),
          afterItemFingerprint: cartItemFingerprint(cart),
          directControl: changed ? 'changed' : 'unchanged',
          identityResolution: 'unique',
          mutationAttempted: true,
          outcome: 'verified_success',
          postCart: retainedPostCartInspection(cart),
          reconciliation: 'verified',
          unrelatedCartPreserved,
        } satisfies ProductMutationVerification,
        ...(screenEvidence ? { screenEvidence } : {}),
      }, cart);
    }, control);
  }

  public async setCartItemQuantity(
    productId: string,
    quantity: number,
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    const exactProductId = productId.trim();
    if (!exactProductId) {
      return executionFailure(
        'set_cart_item_quantity',
        'input',
        'invalid_product',
        false,
      );
    }
    if (!validQuantity(quantity)) {
      return executionFailure(
        'set_cart_item_quantity',
        'input',
        'invalid_quantity',
        false,
      );
    }

    await this.status('Checking your cart', 'working', control, 'verifying');
    return this.execute('set_cart_item_quantity', async (driver) => {
      let before: CartReview | undefined;
      try {
        before = await driver.inspectCart();
      } catch (error) {
        throw new ReversibleExecutionError(
          'inspection',
          'cart_inspection_failed',
          true,
          { cause: error },
        );
      }
      const matches = before?.lines.filter(
        (line) => line.productId === exactProductId,
      ) ?? [];
      if (!before || matches.length !== 1) {
        throw new ReversibleExecutionError(
          'matching',
          'offer_not_found',
          false,
        );
      }

      const target = matches[0]!;
      let after: CartReview | undefined;
      try {
        await control?.markMutationAttemptedAtProviderBoundary(
          'cart quantity mutation attempted',
        );
        after = await driver.setExistingCartItemQuantity(
          exactProductId,
          quantity,
        );
        control?.markReconciling('verifying cart quantity');
      } catch (error) {
        control?.markReconciling('reconciling uncertain cart quantity');
        throw mutationError(error);
      }
      const updated = after?.lines.filter(
        (line) => line.productId === exactProductId,
      ) ?? [];
      if (
        !after
        || updated.length !== 1
        || updated[0]?.quantity !== quantity
        || !otherLinesUnchanged(before, after, exactProductId)
      ) {
        throw new ReversibleExecutionError(
          'verification',
          'verification_failed',
          true,
        );
      }

      const spokenLabel = buildProductSpokenLabels([{
        offerId: target.productId,
        title: target.name,
      }]).get(target.productId) ?? target.name;
      const screenEvidence = await this.currentScreenEvidence(driver, control);
      await this.status(
        `${spokenLabel} updated`,
        'success',
        control,
        'completed',
      );
      return {
        cart: cartResult(after),
        ok: true,
        product: target.name,
        productId: target.productId,
        quantity,
        spokenLabel,
        status: 'quantity_updated',
        verification: {
          directControl: 'changed',
          mutationAttempted: true,
          outcome: 'verified_success',
          postCart: retainedPostCartInspection(after),
          reconciliation: 'verified',
          unrelatedCartPreserved: true,
        } satisfies ProductMutationVerification,
        ...(screenEvidence ? { screenEvidence } : {}),
      };
    }, control);
  }

  public async removeCartItem(
    productId: string,
    control?: PhoneOperationExecutionControl,
  ): Promise<ReversibleExecutionResult> {
    const exactProductId = productId.trim();
    if (!exactProductId) {
      return executionFailure(
        'remove_cart_item',
        'input',
        'invalid_product',
        false,
      );
    }

    await this.status('Checking your cart', 'working', control, 'verifying');
    return this.execute('remove_cart_item', async (driver) => {
      let before: CartReview | undefined;
      try {
        before = await driver.inspectCart();
      } catch (error) {
        throw new ReversibleExecutionError(
          'inspection',
          'cart_inspection_failed',
          true,
          { cause: error },
        );
      }
      const matches = before?.lines.filter(
        (line) => line.productId === exactProductId,
      ) ?? [];
      if (!before || matches.length !== 1) {
        throw new ReversibleExecutionError(
          'matching',
          'offer_not_found',
          false,
        );
      }

      const target = matches[0]!;
      let after: CartReview | undefined;
      try {
        await control?.markMutationAttemptedAtProviderBoundary(
          'cart removal attempted',
        );
        after = await driver.removeExistingCartItem(exactProductId);
        control?.markReconciling('verifying cart removal');
      } catch (error) {
        control?.markReconciling('reconciling uncertain cart removal');
        throw mutationError(error);
      }
      if (
        after?.lines.some((line) => line.productId === exactProductId)
        || !otherLinesUnchanged(before, after, exactProductId)
      ) {
        throw new ReversibleExecutionError(
          'verification',
          'verification_failed',
          true,
        );
      }

      const spokenLabel = buildProductSpokenLabels([{
        offerId: target.productId,
        title: target.name,
      }]).get(target.productId) ?? target.name;
      const screenEvidence = await this.currentScreenEvidence(driver, control);
      await this.status(
        `${spokenLabel} removed`,
        'success',
        control,
        'completed',
      );
      return {
        ok: true,
        product: target.name,
        productId: target.productId,
        spokenLabel,
        status: 'removed',
        ...(after ? { cart: cartResult(after) } : {}),
        ...(after
          ? {
              verification: {
                directControl: 'changed',
                mutationAttempted: true,
                outcome: 'verified_success',
                postCart: retainedPostCartInspection(after),
                reconciliation: 'verified',
                unrelatedCartPreserved: true,
              } satisfies ProductMutationVerification,
            }
          : {}),
        ...(screenEvidence ? { screenEvidence } : {}),
      };
    }, control);
  }
}

export const blinkitExecutionService = new BlinkitExecutionService();
