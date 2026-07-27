import { createHash } from 'node:crypto';
import { AndroidCartReviewSchemaV1, AndroidCheckoutReviewSchemaV1, type AndroidCartReviewV1, type AndroidCheckoutReviewV1, type AndroidExpectedCheckoutV1 } from '@errandos/contracts';
import type { AndroidOrderCandidate } from './android-commit.js';
import { detectBlinkitAndroidStage } from './android-stage.js';

export interface SelectedCheckoutItem {
  offerId: string;
  title: string;
  quantity: number;
  unitPrice: number;
}

export interface LiveReviewEvidence {
  selectedItems?: readonly SelectedCheckoutItem[];
  unavailableItems?: AndroidCheckoutReviewV1['unavailableItems'];
  billSource?: string | undefined;
}

export function hasCashOnDeliveryEvidence(source: string): boolean {
  return /(?:cash(?:\s+on)?|pay\s+on)\s+delivery/i.test(source)
    && !/(?:cash(?:\s+on)?|pay\s+on)\s+delivery(?:\s+is)?\s+(?:not\s+available|unavailable|disabled)/i.test(source);
}

const money = (amount: number): { currency: 'INR'; amount: number } => ({ currency: 'INR', amount });
const minor = (amount: number): number => Math.round(amount * 100);

export function parseLiveAndroidCart(source: string): AndroidCartReviewV1 | undefined {
  const nodes = parseElements(source);
  const shipmentIndex = nodes.findIndex((node) => /shipment of \d+ items?/i.test(labelOf(node)));
  const recommendationIndex = nodes.findIndex((node, index) => index > shipmentIndex && /you might also like/i.test(labelOf(node)));
  if (shipmentIndex < 0) return undefined;
  const cartEnd = recommendationIndex < 0 ? nodes.length : recommendationIndex;
  const lines: AndroidCartReviewV1['lines'] = [];
  for (let index = shipmentIndex + 1; index < cartEnd; index += 1) {
    const node = nodes[index]!;
    const name = node['content-desc']?.trim();
    if (!name || !node['resource-id']?.endsWith('/title')) continue;
    const nearby = nodes.slice(index + 1, Math.min(cartEnd, index + 20));
    const quantityNode = nearby.find((candidate) => candidate['resource-id']?.endsWith('/tv_title') && /^quantity \d+$/i.test(labelOf(candidate)));
    const totalNode = nearby.find((candidate) => candidate['resource-id']?.endsWith('/total_item_price'));
    const quantityMatch = /^quantity (\d+)$/i.exec(quantityNode ? labelOf(quantityNode) : '');
    const totalValue = totalNode ? extractMoneyValues(labelOf(totalNode))[0] : undefined;
    if (!quantityMatch?.[1] || totalValue === undefined) continue;
    const quantity = parseInteger(quantityMatch[1]);
    const unitAmount = totalValue / quantity;
    if (minor(unitAmount) * quantity !== minor(totalValue)) throw new Error('invalid live cart line');
    lines.push({
      productId: `cart_${createHash('sha256').update(`${name}\n${minor(unitAmount)}`).digest('hex').slice(0, 32)}`,
      name,
      quantity,
      unitPrice: money(unitAmount),
      lineTotal: money(totalValue),
    });
  }
  if (lines.length === 0) return undefined;

  const unavailableItems: AndroidCartReviewV1['unavailableItems'] = [];
  const unavailableStart = nodes.findIndex((node) => /\d+ items? (?:are|is) not in stock/i.test(labelOf(node)));
  const unavailableEnd = nodes.findIndex((node, index) => index > unavailableStart && /add these items instead/i.test(labelOf(node)));
  if (unavailableStart >= 0) {
    for (const node of nodes.slice(unavailableStart + 1, unavailableEnd < 0 ? shipmentIndex : unavailableEnd)) {
      const query = node['text']?.trim();
      if (query && node['resource-id']?.endsWith('/title')) unavailableItems.push({ query, reason: 'out_of_stock' });
    }
  }

  const addressText = nodes.map(labelOf).find((label) => /^delivering to\s+.+/i.test(label));
  const addressLabel = addressText?.replace(/^delivering to\s+/i, '').trim();
  if (!addressLabel) throw new Error('missing cart address');
  const subtotalAmount = lines.reduce((sum, line) => sum + line.lineTotal.amount, 0);
  const labels = nodes.map(labelOf).filter(Boolean);
  const etaMinutes = extractEtaMinutes(labels);
  const paymentMode = hasCashOnDeliveryEvidence(source)
    ? 'cod' as const
    : /select payment option|pay using/i.test(source) ? 'unselected' as const : 'other' as const;
  const material = {
    lines,
    unavailableItems,
    subtotal: money(subtotalAmount),
    addressReference: `saved:${normalizeReference(addressLabel)}`,
    addressLabel,
    paymentMode,
    ...(etaMinutes ? { etaMinutes } : {}),
  };
  return AndroidCartReviewSchemaV1.parse({
    ...material,
    providerFingerprint: createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  });
}

export function buildLiveAndroidReview(
  source: string,
  addressReference: string,
  addressLabel: string,
  evidence: LiveReviewEvidence,
): AndroidCheckoutReviewV1 {
  const selectedItems = evidence.selectedItems ?? [];
  if (selectedItems.length === 0) throw new Error('missing live lines');
  const labels = extractLabels(source);
  const billLabels = extractLabels(evidence.billSource ?? '');
  if (!hasCashOnDeliveryEvidence(`${source}\n${evidence.billSource ?? ''}`)) throw new Error('missing cod evidence');
  if (!containsLabel(labels, addressLabel)) throw new Error('missing address evidence');

  const lines = selectedItems.map((item) => {
    if (!hasLineEvidence(labels, item)) throw new Error('missing line evidence');
    return {
      productId: item.offerId,
      name: item.title,
      quantity: item.quantity,
      unitPrice: money(item.unitPrice),
      lineTotal: money(item.unitPrice * item.quantity),
    };
  });
  const totalAmount = extractCheckoutTotal([...labels, ...billLabels]);
  const fees = extractLiveFees(billLabels);
  const accountedMinor = lines.reduce((sum, line) => sum + minor(line.lineTotal.amount), 0)
    + fees.reduce((sum, fee) => sum + (fee.kind === 'discount' ? -1 : 1) * minor(fee.amount.amount), 0);
  const residualMinor = minor(totalAmount) - accountedMinor;
  if (residualMinor !== 0) {
    fees.push(residualMinor > 0
      ? { kind: 'other', label: 'Other provider charges', amount: money(residualMinor / 100) }
      : { kind: 'discount', label: 'Other provider discount', amount: money(Math.abs(residualMinor) / 100) });
  }

  const etaMinutes = extractEtaMinutes(labels);
  const material = {
    lines,
    unavailableItems: evidence.unavailableItems ?? [],
    fees,
    total: money(totalAmount),
    addressReference,
    addressLabel,
    paymentMode: 'cod' as const,
    ...(etaMinutes ? { etaMinutes } : {}),
  };
  return AndroidCheckoutReviewSchemaV1.parse({
    ...material,
    providerFingerprint: createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  });
}

export function parseAndroidOrderCandidates(
  source: string,
  expected: AndroidExpectedCheckoutV1,
  observedAt?: Date,
): AndroidOrderCandidate[] {
  const tagged = parseTags(source, 'order').flatMap((attributes): AndroidOrderCandidate[] => {
    if (attributes['provider-fingerprint'] !== expected.checkout.providerFingerprint) return [];
    const providerReference = attributes['provider-reference'];
    const orderedAt = attributes['ordered-at'];
    if (!providerReference || !orderedAt || !Number.isFinite(Date.parse(orderedAt))) return [];
    return [{ providerReference, orderedAt: new Date(orderedAt).toISOString(), checkout: expected.checkout }];
  });
  if (tagged.length > 0) return tagged;

  const references = extractProviderReferences(source);
  if (detectBlinkitAndroidStage(source) === 'confirmed' && observedAt && references.length === 1) {
    const time = observedAt.getTime();
    if (time >= Date.parse(expected.preparedAt) && time <= Date.parse(expected.expiresAt)) {
      return [{ providerReference: references[0]!, orderedAt: observedAt.toISOString(), checkout: expected.checkout }];
    }
  }

  const labels = extractLabels(source);
  const hasExactTerms = expected.checkout.lines.every((line) => containsLabel(labels, line.name))
    && containsLabel(labels, expected.checkout.addressLabel)
    && /cash\s+on\s+delivery/i.test(source)
    && labels.some((label) => extractMoneyValues(label).some((amount) => minor(amount) === minor(expected.checkout.total.amount)));
  const orderedAt = hasExactTerms ? extractOrderTimestamp(source) : undefined;
  if (!orderedAt) return [];
  return references.map((providerReference) => ({ providerReference, orderedAt, checkout: expected.checkout }));
}

function extractLabels(source: string): string[] {
  return parseElements(source)
    .flatMap((attributes) => [attributes['text'], attributes['content-desc']])
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());
}

function containsLabel(labels: readonly string[], expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  return labels.some((label) => label.trim().toLowerCase() === normalized || label.toLowerCase().includes(normalized));
}

function hasLineEvidence(labels: readonly string[], item: SelectedCheckoutItem): boolean {
  const titleIndex = labels.findIndex((label) => label.trim().toLowerCase() === item.title.trim().toLowerCase());
  if (titleIndex < 0) return false;
  const nearby = labels.slice(titleIndex, titleIndex + 16);
  const validAmounts = new Set([minor(item.unitPrice), minor(item.unitPrice * item.quantity)]);
  return nearby.some((label) => extractMoneyValues(label).some((value) => validAmounts.has(minor(value))))
    && nearby.some((label) => label.trim() === String(item.quantity)
      || label.trim().toLowerCase() === `quantity ${item.quantity}`);
}

function extractCheckoutTotal(labels: readonly string[]): number {
  for (const [index, label] of labels.entries()) {
    if (!/\b(?:bill\s+)?total\b/i.test(label)) continue;
    const nearby = [
      label,
      labels[index - 1], labels[index + 1],
      labels[index - 2], labels[index + 2],
      labels[index - 3], labels[index + 3],
    ].filter((candidate): candidate is string => candidate !== undefined);
    for (const candidate of nearby) {
      const amount = extractMoneyValues(candidate)[0];
      if (amount !== undefined) return amount;
    }
  }
  throw new Error('missing total');
}

function extractEtaMinutes(labels: readonly string[]): number | undefined {
  for (const label of labels) {
    const value = /delivery\s+in\s+(\d{1,3})\s*(?:min|minute)/i.exec(label)?.[1];
    if (value) return parseInteger(value);
  }
  return undefined;
}

function extractLiveFees(labels: readonly string[]): AndroidCheckoutReviewV1['fees'] {
  const fees: AndroidCheckoutReviewV1['fees'] = [];
  const seen = new Set<string>();
  const patterns: readonly [RegExp, AndroidCheckoutReviewV1['fees'][number]['kind']][] = [
    [/delivery\s+(?:charge|fee)/i, 'delivery'], [/handling\s+(?:charge|fee)/i, 'handling'],
    [/platform\s+(?:charge|fee)/i, 'platform'], [/(?:surge|high demand)\s+(?:charge|fee)/i, 'surge'],
    [/(?:small cart|minimum order)\s+(?:charge|fee)/i, 'other'], [/(?:coupon|discount|savings)/i, 'discount'],
  ];
  for (const [index, label] of labels.entries()) {
    const matched = patterns.find(([pattern]) => pattern.test(label));
    if (!matched) continue;
    const amount = extractMoneyValues(label)[0] ?? extractMoneyValues(labels[index + 1] ?? '')[0];
    if (amount === undefined) continue;
    const normalizedLabel = label.replace(/₹\s*[\d,.]+/g, '').replace(/\s+/g, ' ').trim();
    const key = `${matched[1]}:${normalizedLabel.toLowerCase()}:${minor(amount)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fees.push({ kind: matched[1], label: normalizedLabel, amount: money(amount) });
  }
  return fees;
}

function extractProviderReferences(source: string): string[] {
  const references = [
    ...parseTags(source, 'order').map((attributes) => attributes['provider-reference']),
    ...[...source.matchAll(/(?:order\s*(?:id|number|#)|provider\s*reference)\s*[:#-]?\s*([A-Za-z0-9-]{4,100})/gi)].map((match) => match[1]),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(references)];
}

function extractOrderTimestamp(source: string): string | undefined {
  const value = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/.exec(source)?.[1]
    ?? /(?:placed|ordered)(?:\s+on)?\s*[: -]\s*([^<"\n]{6,80})/i.exec(source)?.[1]?.trim();
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function extractMoneyValues(value: string): number[] {
  return [...value.matchAll(/₹\s*([\d,.]+)/g)].map((match) => parseAmount(match[1] ?? ''));
}

function parseElements(source: string): Record<string, string>[] {
  return [...source.matchAll(/<(?!\/|\?|!)[A-Za-z_][\w.:-]*\b([^>]*)\/?>/g)].map((match) => parseAttributes(match[1] ?? ''));
}

function labelOf(attributes: Record<string, string>): string {
  return (attributes['content-desc'] || attributes['text'] || '').trim();
}

function normalizeReference(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'address';
}

function parseTags(source: string, tag: string): Record<string, string>[] {
  return [...source.matchAll(new RegExp(`<${tag}\\b([^>]*)/?>`, 'gi'))].map((match) => parseAttributes(match[1] ?? ''));
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]!] = decodeXml(match[2]!);
  return attributes;
}

function decodeXml(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function parseAmount(value: string): number {
  const amount = Number(value.replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid amount');
  return amount;
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('invalid integer');
  return parsed;
}
