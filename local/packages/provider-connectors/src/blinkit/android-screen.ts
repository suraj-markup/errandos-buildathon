import { AndroidCurrentScreenSchemaV1, type AndroidCurrentScreenV1 } from '@errandos/contracts';
import { detectBlinkitAndroidStage } from './android-stage.js';

type Attributes = Record<string, string>;

export function classifyBlinkitAndroidScreen(source: string): AndroidCurrentScreenV1 {
  const stage = detectBlinkitAndroidStage(source);
  const nodes = parseElements(source);
  const has = (label: string): boolean => nodes.some((attributes) =>
    [attributes['text'], attributes['content-desc']].some((value) => value?.trim().toLowerCase() === label.toLowerCase()));
  const productDetail = has('Navigate up')
    && (has('Select Unit') || has('Add to cart') || nodes.some((node) => node['resource-id']?.endsWith('/info_text')));

  let kind: AndroidCurrentScreenV1['kind'];
  if (stage === 'login_required') kind = 'login';
  else if (stage === 'otp_requested') kind = 'otp';
  else if (stage === 'location_permission') kind = 'location_prompt';
  else if (stage === 'review_prompt') kind = 'review_prompt';
  else if (stage === 'confirmed') kind = 'order_confirmation';
  else if (stage === 'payment_sheet' || isPaymentSurface(source)) kind = 'payment';
  else if (stage === 'address_picker') kind = 'address_selection';
  else if (isOrderHistorySurface(source)) kind = 'order_history';
  else if (productDetail) kind = 'product_detail';
  else if (stage === 'checkout') kind = has('View cart') ? 'cart' : 'checkout';
  else if (isSearchResultsSurface(source)) kind = 'search_results';
  else if (isSearchSurface(source)) kind = 'search';
  else if (stage === 'storefront') kind = 'home';
  else kind = 'unknown';

  const searchAction: AndroidCurrentScreenV1['searchAction'] = (
    kind === 'home' || kind === 'search' || kind === 'search_results' || (kind === 'product_detail' && has('Search'))
  )
    ? 'available'
    : (
      kind === 'product_detail'
      || kind === 'cart'
      || kind === 'checkout'
      || kind === 'payment'
      || kind === 'address_selection'
      || kind === 'order_confirmation'
      || kind === 'order_history'
      || kind === 'location_prompt'
      || kind === 'review_prompt'
    )
      ? 'recoverable'
      : 'blocked';

  const cartItemCount = readCartItemCount(nodes);
  const product = kind === 'product_detail' ? readProduct(nodes) : undefined;
  return AndroidCurrentScreenSchemaV1.parse({
    kind,
    searchAction,
    ...(cartItemCount !== undefined ? { cartItemCount } : {}),
    ...(product ? { product } : {}),
  });
}

function readProduct(nodes: readonly Attributes[]): AndroidCurrentScreenV1['product'] {
  const names = unique(nodes
    .filter((attributes) => attributes['resource-id']?.endsWith('/title'))
    .map((attributes) => attributes['content-desc'] || attributes['text'] || '')
    .filter((value) => value && !/^(?:select unit|view details)$/i.test(value)));
  const name = names[0];
  if (!name) return undefined;

  const packSize = nodes.find((attributes) => attributes['resource-id']?.endsWith('/tv_title2'))
    ?.['text']?.trim();
  const priceText = nodes.find((attributes) => attributes['resource-id']?.endsWith('/info_text'))
    ?.['text'];
  const amount = priceText ? parseAmount(priceText) : undefined;
  return {
    name,
    ...(packSize ? { packSize } : {}),
    ...(amount !== undefined ? { price: { currency: 'INR', amount } } : {}),
  };
}

function readCartItemCount(nodes: readonly Attributes[]): number | undefined {
  for (const attributes of nodes) {
    const value = attributes['text'] || attributes['content-desc'] || '';
    const match = /^(\d+)\s+items?$/i.exec(value.trim());
    if (!match?.[1]) continue;
    const count = Number(match[1]);
    if (Number.isInteger(count) && count >= 0 && count <= 100) return count;
  }
  return undefined;
}

function isSearchSurface(source: string): boolean {
  return /recent searches|clear all/i.test(source)
    || (/voice search/i.test(source) && !/search for atta, dal, coke and more/i.test(source));
}

function isSearchResultsSurface(source: string): boolean {
  return /\bis\s+(?:available|unavailable|not available)\s+for\s+₹/i.test(source)
    && (/voice search|filters|sort/i.test(source));
}

function isPaymentSurface(source: string): boolean {
  return /payment options|pay by any upi app|amazon pay balance|\bpay later\b|credit card|debit card|wallet/i.test(source);
}

function isOrderHistorySurface(source: string): boolean {
  return /order history|search your grocery orders|ordered on|order\s*(?:id|number|no\.?|#)/i.test(source);
}

function parseElements(source: string): Attributes[] {
  return [...source.matchAll(/<(?!\/|\?|!)[A-Za-z_][\w.:-]*\b([^>]*)\/?>/g)]
    .map((match) => parseAttributes(match[1] ?? ''));
}

function parseAttributes(value: string): Attributes {
  const attributes: Attributes = {};
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attributes[match[1]!] = decodeXml(match[2]!);
  }
  return attributes;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function parseAmount(value: string): number | undefined {
  const amount = Number(value.replace(/[₹,\s]/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
