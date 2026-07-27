import {
  AndroidWorkerRequestSchemaV1,
  AndroidWorkerResponseSchemaV1,
  RapidoAndroidWorkerRequestSchemaV1,
  RapidoAndroidWorkerResponseSchemaV1,
  type AndroidCartReviewV1,
  type AndroidCheckoutReviewV1,
  type AndroidWorkerRequestV1,
  type AndroidWorkerResponseV1,
  type BlinkitProposalChangeV1,
  type RapidoAndroidRideReviewV1,
  type RapidoProposalChangeV1,
  type RapidoAndroidWorkerRequestV1,
  type RapidoAndroidWorkerResponseV1,
} from '@errandos/contracts';
import {
  AppiumHttpClient,
  BlinkitAndroidDriver,
  BlinkitCheckoutBlockedError,
  FileAndroidCommitStore,
  RapidoAndroidDriver,
  commitOnce,
  commitRapidoRideOnce,
  reconcileRapidoRide,
  reconcileFromOrderHistory,
} from '@errandos/provider-connectors';

export interface AndroidJobDependencies {
  execute(request: AndroidWorkerRequestV1): Promise<AndroidWorkerResponseV1>;
}

export interface RapidoAndroidJobDependencies {
  execute(request: RapidoAndroidWorkerRequestV1): Promise<RapidoAndroidWorkerResponseV1>;
}

interface SafeWorkerFailure {
  stage: string;
  itemSubtotal?: number;
  requiredSubtotal?: number;
}

const errorResponse = (operation: AndroidWorkerRequestV1['operation'], failure: string | SafeWorkerFailure): AndroidWorkerResponseV1 => {
  const safe = typeof failure === 'string' ? { stage: failure } : failure;
  return AndroidWorkerResponseSchemaV1.parse({
    version: 1,
    operation,
    status: 'error',
    ...safe,
  });
};

export async function runAndroidJob(input: string, dependencies: AndroidJobDependencies): Promise<string> {
  const parsed = AndroidWorkerRequestSchemaV1.safeParse(safeJson(input));
  if (!parsed.success) return `${JSON.stringify(errorResponse('auth_status', 'invalid_request'))}\n`;
  try {
    const response = AndroidWorkerResponseSchemaV1.parse(await dependencies.execute(parsed.data));
    return `${JSON.stringify(response)}\n`;
  } catch (error) {
    return `${JSON.stringify(errorResponse(parsed.data.operation, safeFailure(error)))}\n`;
  }
}

export async function runRapidoAndroidJob(input: string, dependencies: RapidoAndroidJobDependencies): Promise<string> {
  const parsed = RapidoAndroidWorkerRequestSchemaV1.safeParse(safeJson(input));
  if (!parsed.success) return `${JSON.stringify({
    version: 1, operation: 'rapido_auth_status', status: 'error', stage: 'invalid_request',
  })}\n`;
  try {
    return `${JSON.stringify(RapidoAndroidWorkerResponseSchemaV1.parse(await dependencies.execute(parsed.data)))}\n`;
  } catch (error) {
    const stage = error instanceof Error
      ? /^Rapido ([a-z][a-z0-9_]{1,63}) failed$/.exec(error.message)?.[1] ?? 'job_execution'
      : 'job_execution';
    return `${JSON.stringify(RapidoAndroidWorkerResponseSchemaV1.parse({
      version: 1, operation: parsed.data.operation, status: 'error', stage,
    }))}\n`;
  }
}

async function executeRapidoLocally(request: RapidoAndroidWorkerRequestV1): Promise<RapidoAndroidWorkerResponseV1> {
  if (request.operation === 'rapido_readiness') return executeRapidoReadiness();
  const ui = await AppiumHttpClient.open({ appPackage: 'com.rapido.passenger' });
  const driver = new RapidoAndroidDriver(ui);
  try {
    switch (request.operation) {
      case 'rapido_auth_status':
        return { version: 1, operation: request.operation, status: await driver.authStatus() };
      case 'rapido_begin_login':
        return { version: 1, operation: request.operation, status: await driver.beginLogin(request.phone) };
      case 'rapido_submit_otp':
        return { version: 1, operation: request.operation, status: await driver.submitOtp(request.otp) };
      case 'rapido_resend_otp':
        return { version: 1, operation: request.operation, status: await driver.resendOtp() };
      case 'rapido_quote_rides': {
        const quote = await driver.quoteRides(request.pickup, request.dropoff, request.limit);
        return { version: 1, operation: request.operation, status: 'completed', ...quote };
      }
      case 'rapido_prepare_ride':
        return {
          version: 1,
          operation: request.operation,
          status: 'prepared',
          ride: await driver.prepareRide(
            request.pickup,
            request.dropoff,
            {
              ...(request.rideOptionId ? { rideOptionId: request.rideOptionId } : {}),
              ...(request.rideType ? { rideType: request.rideType } : {}),
            },
            request.paymentMode,
          ),
        };
      case 'rapido_review_ride':
        return {
          version: 1,
          operation: request.operation,
          status: 'completed',
          comparison: await compareRapidoRide(driver, request.expected),
        };
      case 'rapido_commit_once': {
        const expected = request.expected;
        const result = await commitRapidoRideOnce(expected, {
          store: new FileAndroidCommitStore(process.env['ERRANDOS_RAPIDO_COMMIT_ROOT'] ?? '/var/lib/errandos/rapido-commit'),
          readRide: () => driver.readRideReview(reviewExpectation(expected.ride)),
          clickFinal: () => driver.clickFinalRideOnce(expected.ride.rideOption.name),
          readConfirmation: () => driver.readRideConfirmation(),
        });
        return result.outcome === 'committed'
          ? { version: 1, operation: request.operation, status: 'committed', providerReference: result.providerReference }
          : { version: 1, operation: request.operation, status: result.outcome };
      }
      case 'rapido_reconcile': {
        const result = reconcileRapidoRide(request.expected, await driver.recentTrips(10));
        return result.outcome === 'committed'
          ? { version: 1, operation: request.operation, status: 'committed', providerReference: result.providerReference }
          : { version: 1, operation: request.operation, status: 'pending' };
      }
      case 'rapido_recent_trips':
        return {
          version: 1,
          operation: request.operation,
          status: 'completed',
          trips: await driver.recentTrips(request.limit),
        };
    }
  } finally {
    await ui.close();
  }
}

export async function compareRapidoRide(
  driver: Pick<RapidoAndroidDriver, 'readRideReview'>,
  expected: RapidoAndroidRideReviewV1,
): Promise<{ matches: boolean; changes: Exclude<RapidoProposalChangeV1, 'quote_expiry'>[]; currentProviderFingerprint?: string }> {
  const current = await driver.readRideReview(reviewExpectation(expected));
  const changes: Exclude<RapidoProposalChangeV1, 'quote_expiry'>[] = [];
  if (
    current.pickupReference !== expected.pickupReference
    || current.pickupSummary !== expected.pickupSummary
    || current.dropoffReference !== expected.dropoffReference
    || current.dropoffSummary !== expected.dropoffSummary
  ) changes.push('route');
  if (JSON.stringify(current.rideOption) !== JSON.stringify(expected.rideOption)) changes.push('ride_option');
  if (
    JSON.stringify(current.fareMinimum) !== JSON.stringify(expected.fareMinimum)
    || JSON.stringify(current.fareMaximum) !== JSON.stringify(expected.fareMaximum)
  ) changes.push('fare');
  if (JSON.stringify(current.fees) !== JSON.stringify(expected.fees)) changes.push('fees');
  if (current.pickupEtaMinutes !== expected.pickupEtaMinutes) changes.push('pickup_eta');
  if (current.durationMinutes !== expected.durationMinutes) changes.push('duration');
  if (current.paymentMode !== expected.paymentMode) changes.push('payment_mode');
  if (current.providerFingerprint !== expected.providerFingerprint) changes.push('provider_fingerprint');
  return changes.length === 0
    ? { matches: true, changes: [], currentProviderFingerprint: current.providerFingerprint }
    : { matches: false, changes, currentProviderFingerprint: current.providerFingerprint };
}

function reviewExpectation(ride: RapidoAndroidRideReviewV1): Parameters<RapidoAndroidDriver['readRideReview']>[0] {
  return {
    pickupSummary: ride.pickupSummary,
    dropoffSummary: ride.dropoffSummary,
    option: {
      rideOptionId: ride.rideOption.id,
      name: ride.rideOption.name,
      fareMinimum: ride.fareMinimum,
      fareMaximum: ride.fareMaximum,
      fees: ride.fees,
      ...(ride.pickupEtaMinutes !== undefined ? { pickupEtaMinutes: ride.pickupEtaMinutes } : {}),
      ...(ride.durationMinutes !== undefined ? { durationMinutes: ride.durationMinutes } : {}),
      available: true,
    },
    paymentMode: ride.paymentMode,
  };
}

async function executeLocally(request: AndroidWorkerRequestV1): Promise<AndroidWorkerResponseV1> {
  if (request.operation === 'readiness') return executeReadiness();
  const ui = await AppiumHttpClient.open();
  const driver = new BlinkitAndroidDriver(ui);
  try {
    switch (request.operation) {
      case 'current_screen': return {
        version: 1,
        operation: request.operation,
        status: 'completed',
        screen: await driver.currentScreen(),
      };
      case 'auth_status': return { version: 1, operation: request.operation, status: await driver.authStatus() };
      case 'begin_login': return { version: 1, operation: request.operation, status: await driver.beginLogin(request.phone) };
      case 'submit_otp': return { version: 1, operation: request.operation, status: await driver.submitOtp(request.otp) };
      case 'search': return { version: 1, operation: request.operation, status: 'completed', offers: await driver.search(request.query, request.limit) };
      case 'inspect_cart': {
        const cart = await driver.inspectCart();
        return cart
          ? { version: 1, operation: request.operation, status: 'completed', cart }
          : { version: 1, operation: request.operation, status: 'empty' };
      }
      case 'share_cart': return {
        version: 1,
        operation: request.operation,
        status: 'completed',
        ...await driver.shareCart(),
      };
      case 'import_shared_cart': return {
        version: 1,
        operation: request.operation,
        status: 'completed',
        ...await driver.importSharedCart(request.shareUrl),
      };
      case 'upsert_cart_item': return {
        version: 1,
        operation: request.operation,
        status: 'completed',
        cart: await driver.upsertCartItem(request.query, request.offerId, request.quantity),
      };
      case 'set_cart_quantity': {
        const cart = await driver.setExistingCartItemQuantity(request.productId, request.quantity);
        return cart
          ? { version: 1, operation: request.operation, status: 'completed', cart }
          : { version: 1, operation: request.operation, status: 'empty' };
      }
      case 'remove_cart_item': {
        const cart = await driver.removeExistingCartItem(request.productId);
        return cart
          ? { version: 1, operation: request.operation, status: 'completed', cart }
          : { version: 1, operation: request.operation, status: 'empty' };
      }
      case 'clear_cart': {
        await driver.clearCart();
        const cart = await driver.inspectCart();
        return cart
          ? { version: 1, operation: request.operation, status: 'completed', cart }
          : { version: 1, operation: request.operation, status: 'empty' };
      }
      case 'list_saved_addresses': return {
        version: 1,
        operation: request.operation,
        status: 'completed',
        addresses: await driver.listSavedAddresses(request.requestedLabel),
      };
      case 'select_saved_address': {
        const selectedAddress = await driver.selectSavedAddressReference(request.addressReference);
        return {
          version: 1,
          operation: request.operation,
          status: 'completed',
          selectedAddress,
        };
      }
      case 'recent_orders': return {
        version: 1,
        operation: request.operation,
        status: 'completed',
        orders: await driver.readRecentOrders(request.limit),
      };
      case 'review_checkout': {
        const cart = await driver.inspectCart();
        return {
          version: 1,
          operation: request.operation,
          status: 'completed',
          comparison: await compareCheckout(driver, cart, request.expected),
        };
      }
      case 'prepare_checkout': return {
        version: 1,
        operation: request.operation,
        status: 'prepared',
        checkout: await driver.prepareCheckout(request.items, request.addressReference, request.addressLabel),
      };
      case 'prepare_existing_checkout': return {
        version: 1,
        operation: request.operation,
        status: 'prepared',
        checkout: await driver.prepareExistingCheckout(),
      };
      case 'commit_once': {
        const result = await commitOnce(request.expected, {
          store: new FileAndroidCommitStore(process.env['ERRANDOS_ANDROID_COMMIT_ROOT'] ?? '/var/lib/errandos/commit'),
          readCheckout: () => driver.readCheckoutReview(
            request.expected.checkout.addressReference,
            request.expected.checkout.addressLabel,
            request.expected.checkout,
          ),
          clickFinal: () => driver.clickFinalOrderOnce(),
          readConfirmation: () => driver.readConfirmation(),
        });
        return result.outcome === 'committed'
          ? { version: 1, operation: request.operation, status: 'committed', providerReference: result.providerReference }
          : { version: 1, operation: request.operation, status: result.outcome };
      }
      case 'reconcile': {
        const result = await reconcileFromOrderHistory(request.expected, {
          readOrders: () => driver.readOrderHistory(request.expected),
        });
        return result.outcome === 'committed'
          ? { version: 1, operation: request.operation, status: 'committed', providerReference: result.providerReference }
          : { version: 1, operation: request.operation, status: 'pending' };
      }
    }
  } finally {
    await ui.close();
  }
}

export async function compareCheckout(
  driver: Pick<BlinkitAndroidDriver, 'readCheckoutReview'>,
  cart: AndroidCartReviewV1 | undefined,
  expected: AndroidCheckoutReviewV1,
): Promise<{ matches: boolean; changes: BlinkitProposalChangeV1[]; currentProviderFingerprint?: string }> {
  if (!cart) return { matches: false, changes: ['items', 'provider_fingerprint'] };
  const changes: BlinkitProposalChangeV1[] = [];
  if (JSON.stringify(lineTerms(cart.lines)) !== JSON.stringify(lineTerms(expected.lines))) changes.push('items');
  if (JSON.stringify(unavailableTerms(cart.unavailableItems)) !== JSON.stringify(unavailableTerms(expected.unavailableItems))) {
    changes.push('unavailable_items');
  }
  if (cart.addressLabel !== expected.addressLabel) changes.push('address');
  if (cart.paymentMode !== expected.paymentMode) changes.push('payment_mode');
  if (changes.length > 0) return { matches: false, changes: [...changes, 'provider_fingerprint'] };

  const current = await driver.readCheckoutReview(expected.addressReference, cart.addressLabel, expected);
  if (JSON.stringify(current.fees) !== JSON.stringify(expected.fees)) changes.push('fees');
  if (JSON.stringify(current.total) !== JSON.stringify(expected.total)) changes.push('total');
  if (current.etaMinutes !== expected.etaMinutes) changes.push('eta');
  if (current.providerFingerprint !== expected.providerFingerprint) changes.push('provider_fingerprint');
  return changes.length === 0
    ? { matches: true, changes: [], currentProviderFingerprint: current.providerFingerprint }
    : { matches: false, changes, currentProviderFingerprint: current.providerFingerprint };
}

function lineTerms(lines: AndroidCartReviewV1['lines'] | AndroidCheckoutReviewV1['lines']): unknown[] {
  return lines.map((line) => ({
    name: line.name.trim().toLocaleLowerCase('en-IN'),
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function unavailableTerms(items: AndroidCartReviewV1['unavailableItems']): unknown[] {
  return items.map((item) => ({
    query: item.query.trim().toLocaleLowerCase('en-IN'),
    reason: item.reason,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function executeReadiness(): Promise<AndroidWorkerResponseV1> {
  if (!(await AppiumHttpClient.isReady())) {
    return {
      version: 1,
      operation: 'readiness',
      status: 'completed',
      dependencies: {
        appium: 'unavailable',
        emulator: 'unknown',
        blinkitApp: 'unknown',
        authentication: 'unknown',
      },
    };
  }

  let ui: AppiumHttpClient;
  try {
    ui = await AppiumHttpClient.open();
  } catch {
    return {
      version: 1,
      operation: 'readiness',
      status: 'completed',
      dependencies: {
        appium: 'ready',
        emulator: 'unavailable',
        blinkitApp: 'unknown',
        authentication: 'unknown',
      },
    };
  }

  try {
    const driver = new BlinkitAndroidDriver(ui);
    let authentication: 'active' | 'login_required' | 'challenge_required' | 'unknown' = 'unknown';
    try {
      authentication = await driver.authStatus();
    } catch {
      authentication = 'unknown';
    }
    return {
      version: 1,
      operation: 'readiness',
      status: 'completed',
      dependencies: {
        appium: 'ready',
        emulator: 'ready',
        blinkitApp: 'ready',
        authentication,
      },
    };
  } finally {
    await ui.close();
  }
}

async function executeRapidoReadiness(): Promise<RapidoAndroidWorkerResponseV1> {
  if (!(await AppiumHttpClient.isReady())) {
    return {
      version: 1,
      operation: 'rapido_readiness',
      status: 'completed',
      dependencies: { appium: 'unavailable', emulator: 'unknown', rapidoApp: 'unknown', authentication: 'unknown' },
    };
  }
  let ui: AppiumHttpClient;
  try {
    ui = await AppiumHttpClient.open({ appPackage: 'com.rapido.passenger' });
  } catch {
    return {
      version: 1,
      operation: 'rapido_readiness',
      status: 'completed',
      dependencies: { appium: 'ready', emulator: 'unavailable', rapidoApp: 'unknown', authentication: 'unknown' },
    };
  }
  try {
    let authentication: 'active' | 'login_required' | 'challenge_required' | 'unknown' | 'device_verification_failed' = 'unknown';
    try {
      authentication = await new RapidoAndroidDriver(ui).authStatus();
    } catch (error) {
      authentication = error instanceof Error && /Rapido device_verification_failed failed/.test(error.message)
        ? 'device_verification_failed'
        : 'unknown';
    }
    return {
      version: 1,
      operation: 'rapido_readiness',
      status: 'completed',
      dependencies: { appium: 'ready', emulator: 'ready', rapidoApp: 'ready', authentication },
    };
  } finally {
    await ui.close();
  }
}

async function main(): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 65_536) {
      process.stdout.write(`${JSON.stringify(errorResponse('auth_status', 'request_too_large'))}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const raw = safeJson(input);
  const output = RapidoAndroidWorkerRequestSchemaV1.safeParse(raw).success
    ? await runRapidoAndroidJob(input, { execute: executeRapidoLocally })
    : await runAndroidJob(input, { execute: executeLocally });
  process.stdout.write(output);
  if (output.includes('"status":"error"')) process.exitCode = 1;
}

function safeJson(input: string): unknown {
  try { return JSON.parse(input); } catch { return undefined; }
}

function safeFailureStage(error: unknown): string {
  if (!(error instanceof Error)) return 'job_execution';
  return /^Blinkit ([a-z][a-z0-9_]{1,63}) failed$/.exec(error.message)?.[1] ?? 'job_execution';
}

function safeFailure(error: unknown): SafeWorkerFailure {
  if (error instanceof BlinkitCheckoutBlockedError) {
    return {
      stage: error.reason,
      ...(error.details ?? {}),
    };
  }
  return { stage: safeFailureStage(error) };
}

if (process.argv[1]?.endsWith('/android-job-entry.js')) void main();
