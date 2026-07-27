import { createHash } from 'node:crypto';
import {
  AndroidRecentOrderSchemaV1,
  AndroidSavedAddressSchemaV1,
  type AndroidRecentOrderV1,
  type AndroidSavedAddressV1,
} from '@errandos/contracts';

type Attributes = Record<string, string>;

export function parseSavedAddresses(source: string): AndroidSavedAddressV1[] {
  const addresses: AndroidSavedAddressV1[] = [];
  const seen = new Set<string>();
  for (const attributes of parseElements(source)) {
    const resourceId = attributes['resource-id']?.toLowerCase() ?? '';
    if (!/(?:^|[/_])address_(?:type|label|tag)$|(?:^|\/)location_title$/.test(resourceId)) continue;
    const address = savedAddressFromLabel(labelOf(attributes));
    if (!address) continue;
    const normalized = address.label.toLocaleLowerCase('en-IN');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    addresses.push(address);
    if (addresses.length === 20) break;
  }
  return addresses;
}

export function savedAddressFromLabel(value: string): AndroidSavedAddressV1 | undefined {
  const label = safeAddressLabel(value);
  if (!label) return undefined;
  const normalized = label.toLocaleLowerCase('en-IN');
  return AndroidSavedAddressSchemaV1.parse({
    addressReference: `address_${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`,
    label,
  });
}

export function parseRecentOrders(source: string, limit: number, now = new Date()): AndroidRecentOrderV1[] {
  const nodes = parseElements(source);
  const starts = nodes.flatMap((node, index) => orderReference(labelOf(node)) ? [index] : []);
  const orders: AndroidRecentOrderV1[] = [];
  for (const [position, start] of starts.entries()) {
    const labels = nodes.slice(start, starts[position + 1] ?? nodes.length).map(labelOf).filter(Boolean);
    const reference = orderReference(labels[0] ?? '');
    const total = labels.flatMap(extractTotal)[0];
    const orderedAt = labels.map(extractTimestamp).find((value): value is string => value !== undefined);
    const items = labels.flatMap(extractItem);
    if (!reference || total === undefined || !orderedAt || items.length === 0) continue;
    const providerStatus = extractStatus(labels);
    const parsed = AndroidRecentOrderSchemaV1.safeParse({
      orderReference: reference,
      items,
      total: { currency: 'INR', amount: total },
      orderedAt,
      providerStatus,
    });
    if (parsed.success) orders.push(parsed.data);
    if (orders.length === limit) break;
  }
  if (orders.length >= limit) return orders;
  return appendCurrentOrderCards(nodes.map(labelOf).filter(Boolean), orders, limit, now);
}

function appendCurrentOrderCards(
  labels: readonly string[],
  existing: AndroidRecentOrderV1[],
  limit: number,
  now: Date,
): AndroidRecentOrderV1[] {
  const starts = labels.flatMap((label, index) => /^Arrived in \d+\s+minutes?$/i.test(label) ? [index] : []);
  const orders = [...existing];
  for (const [position, start] of starts.entries()) {
    const card = labels.slice(start, starts[position + 1] ?? labels.length);
    const total = card.map(extractStandalonePrice).find((value): value is number => value !== undefined);
    const orderedAt = card.map((label) => extractProviderTimestamp(label, now)).find((value): value is string => value !== undefined);
    const items = extractCurrentCardItems(card);
    if (total === undefined || !orderedAt || items.length === 0) continue;
    const referenceFacts = JSON.stringify({ orderedAt, total, items: items.map(({ name }) => name) });
    const parsed = AndroidRecentOrderSchemaV1.safeParse({
      orderReference: `order_${createHash('sha256').update(referenceFacts).digest('hex').slice(0, 32)}`,
      items,
      total: { currency: 'INR', amount: total },
      orderedAt,
      providerStatus: 'delivered',
    });
    if (parsed.success && !orders.some((order) => order.orderReference === parsed.data.orderReference)) {
      orders.push(parsed.data);
    }
    if (orders.length === limit) break;
  }
  return orders;
}

function safeAddressLabel(value: string): string | undefined {
  const label = value.replace(/\s+/g, ' ').trim();
  if (!label || label.length > 60 || /[,\n\r]|\b\d{6}\b|@/.test(label)) return undefined;
  return label;
}

function orderReference(value: string): string | undefined {
  return /\border\s*(?:id|number|no\.?|#)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,99})\b/i.exec(value)?.[1];
}

function extractItem(value: string): { name: string; quantity: number }[] {
  const match = /^(.+?)\s*(?:[·•-]\s*)?(?:qty\s*[: ]?|[x×]\s*)(\d{1,3})$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return [];
  const name = match[1].trim();
  const quantity = Number(match[2]);
  if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return [];
  return [{ name, quantity }];
}

function extractTotal(value: string): number[] {
  if (!/\b(?:grand\s+|order\s+)?total\b/i.test(value)) return [];
  const amount = /₹\s*([\d,.]+)/.exec(value)?.[1];
  if (!amount) return [];
  const parsed = Number(amount.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed >= 0 ? [parsed] : [];
}

function extractTimestamp(value: string): string | undefined {
  const raw = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/.exec(value)?.[1];
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function extractStandalonePrice(value: string): number | undefined {
  const amount = /^₹\s*([\d,.]+)$/.exec(value.trim())?.[1];
  if (!amount) return undefined;
  const parsed = Number(amount.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractProviderTimestamp(value: string, now: Date): string | undefined {
  const match = /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec),\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return undefined;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(match[2].toLowerCase());
  const day = Number(match[1]);
  const hour12 = Number(match[3]);
  const minute = Number(match[4]);
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (match[5].toLowerCase() === 'pm' ? 12 : 0);
  let year = now.getUTCFullYear();
  let timestamp = Date.UTC(year, month, day, hour, minute) - 330 * 60 * 1000;
  if (timestamp > now.getTime() + 24 * 60 * 60 * 1000) {
    year -= 1;
    timestamp = Date.UTC(year, month, day, hour, minute) - 330 * 60 * 1000;
  }
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year && !(month === 0 && date.getUTCFullYear() === year - 1)) return undefined;
  return date.toISOString();
}

function extractCurrentCardItems(labels: readonly string[]): { name: string }[] {
  const start = labels.findIndex((label) => /^More options$/i.test(label));
  if (start < 0) return [];
  const end = labels.findIndex((label, index) => index > start && /^Reorder$/i.test(label));
  if (end < 0) return [];
  return labels.slice(start + 1, end)
    .map((name) => name.replace(/\s+/g, ' ').trim())
    .filter(isSafeCurrentOrderItem)
    .slice(0, 50)
    .map((name) => ({ name }));
}

function isSafeCurrentOrderItem(value: string): boolean {
  if (!value || value.length > 300) return false;
  if (/^(?:More options|Reorder|Rate order|Order History|Search your grocery orders)$/i.test(value)) return false;
  if (/^Arrived in \d+\s+minutes?$/i.test(value) || /^₹\s*[\d,.]+$/.test(value)) return false;
  if (/^\d{1,2}\s+[A-Za-z]{3},\s+\d{1,2}:\d{2}\s*(?:am|pm)$/i.test(value)) return false;
  if (/\b(?:delivered\s+to|delivery\s+address|address)\b/i.test(value)) return false;
  if (/\b\d{6}\b|@/.test(value) || /[\r\n]/.test(value)) return false;
  return true;
}

function extractStatus(labels: readonly string[]): AndroidRecentOrderV1['providerStatus'] {
  const value = labels.join(' ').toLowerCase();
  if (/out for delivery/.test(value)) return 'out_for_delivery';
  if (/deliver(?:ed|y complete)/.test(value)) return 'delivered';
  if (/cancel(?:led|ed)/.test(value)) return 'cancelled';
  if (/refund(?:ed| complete)/.test(value)) return 'refunded';
  if (/fail(?:ed|ure)/.test(value)) return 'failed';
  if (/pack(?:ed|ing complete)/.test(value)) return 'packed';
  if (/prepar(?:ing|ed)/.test(value)) return 'preparing';
  if (/confirm(?:ed|ation)/.test(value)) return 'confirmed';
  if (/placed|order received/.test(value)) return 'placed';
  return 'unknown';
}

function parseElements(source: string): Attributes[] {
  return [...source.matchAll(/<(?!\/|\?|!)[A-Za-z_][\w.:-]*\b([^>]*)\/?>/g)]
    .map((match) => parseAttributes(match[1] ?? ''));
}

function parseAttributes(value: string): Attributes {
  const attributes: Attributes = {};
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]!] = decodeXml(match[2]!);
  return attributes;
}

function labelOf(attributes: Attributes): string {
  return (attributes['content-desc'] || attributes['text'] || '').trim();
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}
