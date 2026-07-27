import {
  AppiumHttpClient,
  BlinkitAndroidDriver,
  type AndroidSearchOffer,
} from '@errandos/provider-connectors';
import { publishOverlayStatus } from './overlay';

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

export type HostedGroceryOption = {
  offerId: string;
  product: string;
  price: string;
  size?: string;
};

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

function optionFor(offer: AndroidSearchOffer): HostedGroceryOption {
  return {
    offerId: offer.offerId,
    product: offer.title,
    price: formattedPrice(offer),
    ...(offer.packSize ? { size: offer.packSize } : {}),
  };
}

export function selectExactHostedOffer(
  request: string,
  offers: readonly AndroidSearchOffer[],
  requestedOfferId?: string,
): AndroidSearchOffer | undefined {
  const available = offers.filter((offer) => offer.available);
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

export async function prepareGroceryWithHostedDriver(
  request: string,
  requestedSearchQuery?: string,
  requestedOfferId?: string,
) {
  const spokenRequest = request.trim();
  const searchQuery = requestedSearchQuery?.trim() || spokenRequest;
  if (!spokenRequest || !searchQuery) {
    return {
      ok: false,
      status: 'not_found',
      request: spokenRequest,
      message: 'A grocery product is required.',
    };
  }

  let client: AppiumHttpClient | undefined;
  try {
    await publishOverlayStatus(`Searching for ${searchQuery}`, 'searching');
    client = await AppiumHttpClient.open({
      appPackage: BLINKIT_PACKAGE,
      endpoint: APPIUM_URL,
      ...(DEVICE_UDID ? { udid: DEVICE_UDID } : {}),
    });
    const driver = new BlinkitAndroidDriver(client);
    const existingCart = await driver.inspectCart();
    const offers = await driver.search(searchQuery, 10);
    if (offers.length === 0) {
      await publishOverlayStatus(`I couldn't find ${searchQuery}`, 'clarification');
      return {
        ok: false,
        status: 'not_found',
        request: searchQuery,
        message: `Blinkit did not return a product for “${searchQuery}”.`,
      };
    }

    const selected = selectExactHostedOffer(spokenRequest, offers, requestedOfferId);
    if (!selected) {
      const options = offers.filter((offer) => offer.available).slice(0, 5).map(optionFor);
      const optionSummary = options
        .slice(0, 3)
        .map((option) => `${option.product}${option.size ? ` ${option.size}` : ''}`)
        .join(', ');
      await publishOverlayStatus(`Which one do you want? ${optionSummary}`, 'clarification');
      return {
        ok: false,
        status: 'needs_clarification',
        request: searchQuery,
        options,
        message: 'Ask the user to choose one exact visible product and size.',
      };
    }

    const existingLine = existingCart?.lines.find((line) =>
      line.name.trim().toLocaleLowerCase('en-IN')
        === selected.title.trim().toLocaleLowerCase('en-IN')
      && Math.round(line.unitPrice.amount * 100) === Math.round(selected.price.amount * 100));
    if (existingLine && existingLine.quantity >= 1) {
      const option = optionFor(selected);
      await publishOverlayStatus(
        `${option.product}${option.size ? ` · ${option.size}` : ''} is already in your cart.`,
        'success',
      );
      return {
        ok: true,
        status: 'already_in_cart',
        request: searchQuery,
        product: option.product,
        size: option.size,
        price: option.price,
        quantity: existingLine.quantity,
        cartFingerprint: existingCart?.providerFingerprint,
        message: `${option.product}${option.size ? ` ${option.size}` : ''} is already in the cart.`,
      };
    }

    await publishOverlayStatus(`Adding ${selected.title}`, 'adding');
    const cart = await driver.upsertCartItem(searchQuery, selected.offerId, 1);
    const selectedLine = cart.lines.find((line) =>
      line.name.trim().toLocaleLowerCase('en-IN')
        === selected.title.trim().toLocaleLowerCase('en-IN'));
    if (!selectedLine || selectedLine.quantity !== 1) {
      throw new Error('Blinkit cart verification did not find the selected item.');
    }

    const option = optionFor(selected);
    await publishOverlayStatus(
      `${option.product}${option.size ? ` · ${option.size}` : ''} added to your cart.`,
      'success',
    );
    return {
      ok: true,
      status: 'added',
      request: searchQuery,
      product: option.product,
      size: option.size,
      price: option.price,
      quantity: selectedLine.quantity,
      cartFingerprint: cart.providerFingerprint,
      message: `Added ${option.product}${option.size ? ` ${option.size}` : ''} to the cart and verified it.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Blinkit automation failed.';
    await publishOverlayStatus('I could not complete that Blinkit step. Please try again.', 'error');
    return {
      ok: false,
      status: 'automation_failed',
      request: searchQuery,
      message,
    };
  } finally {
    await client?.close();
  }
}
