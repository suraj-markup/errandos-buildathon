import { createHash } from 'node:crypto';
import type {
  AndroidCheckoutReviewV1,
  BlinkitProposalChangeV1,
} from '@errandos/contracts';

export type CodCheckoutSnapshot = {
  addressLabel: string;
  fingerprint: string;
  itemCount?: number;
  itemNames: string[];
  paymentMode: 'cod';
  total: number;
};

export type CodCheckoutProposalV1 = CodCheckoutSnapshot & {
  checkout: AndroidCheckoutReviewV1;
  expiresAt: string;
  idempotencyKey: string;
  preparedAt: string;
  proposalHash: string;
  proposalId: string;
  version: 1;
};

export function isCodCheckoutProposal(
  value: CodCheckoutSnapshot,
): value is CodCheckoutProposalV1 {
  const candidate = value as Partial<CodCheckoutProposalV1>;
  return candidate.version === 1
    && Boolean(candidate.checkout)
    && typeof candidate.expiresAt === 'string'
    && typeof candidate.idempotencyKey === 'string'
    && typeof candidate.preparedAt === 'string'
    && typeof candidate.proposalHash === 'string'
    && typeof candidate.proposalId === 'string';
}

function stableCheckoutMaterial(checkout: AndroidCheckoutReviewV1) {
  return {
    ...checkout,
    lines: [...checkout.lines].sort((left, right) =>
      left.productId.localeCompare(right.productId)),
    fees: [...checkout.fees].sort((left, right) =>
      `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`)),
    unavailableItems: [...checkout.unavailableItems].sort((left, right) =>
      `${left.query}:${left.reason}`.localeCompare(`${right.query}:${right.reason}`)),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function checkoutTermChanges(
  expected: AndroidCheckoutReviewV1,
  current: AndroidCheckoutReviewV1,
): BlinkitProposalChangeV1[] {
  const changes: BlinkitProposalChangeV1[] = [];
  const expectedStable = stableCheckoutMaterial(expected);
  const currentStable = stableCheckoutMaterial(current);
  if (!sameValue(expectedStable.lines, currentStable.lines)) changes.push('items');
  if (
    !sameValue(
      expectedStable.unavailableItems,
      currentStable.unavailableItems,
    )
  ) changes.push('unavailable_items');
  if (!sameValue(expectedStable.fees, currentStable.fees)) changes.push('fees');
  if (!sameValue(expected.total, current.total)) changes.push('total');
  if (
    expected.addressReference !== current.addressReference
    || expected.addressLabel !== current.addressLabel
  ) changes.push('address');
  if (expected.paymentMode !== current.paymentMode) changes.push('payment_mode');
  if (expected.etaMinutes !== current.etaMinutes) changes.push('eta');
  if (expected.providerFingerprint !== current.providerFingerprint) {
    changes.push('provider_fingerprint');
  }
  return changes;
}

export function buildCodCheckoutProposal(
  checkout: AndroidCheckoutReviewV1,
  now: Date,
  ttlMs: number,
): CodCheckoutProposalV1 {
  if (checkout.lines.length === 0) throw new Error('Checkout cart is empty.');
  if (checkout.paymentMode !== 'cod') {
    throw new Error('Checkout payment mode is not Cash on Delivery.');
  }
  if (
    !checkout.addressLabel.trim()
    || !checkout.addressReference.trim()
    || !/^[a-f0-9]{64}$/.test(checkout.providerFingerprint)
    || !Number.isFinite(checkout.total.amount)
    || checkout.total.amount < 0
  ) {
    throw new Error('Checkout terms are incomplete.');
  }
  const preparedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const proposalHash = createHash('sha256')
    .update(JSON.stringify(stableCheckoutMaterial(checkout)))
    .digest('hex');
  return {
    version: 1,
    addressLabel: checkout.addressLabel,
    checkout,
    expiresAt,
    fingerprint: checkout.providerFingerprint,
    idempotencyKey: `checkout.${proposalHash}`,
    itemCount: checkout.lines.reduce((sum, line) => sum + line.quantity, 0),
    itemNames: checkout.lines.map((line) => line.name),
    paymentMode: 'cod',
    preparedAt,
    proposalHash,
    proposalId: `checkout_${proposalHash}`,
    total: checkout.total.amount,
  };
}

export function isExplicitCodConfirmation(transcript: string): boolean {
  const normalized = transcript
    .toLocaleLowerCase('en-IN')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return /^(?:please )?confirm (?:cod|c o d) order(?: please)?$/
    .test(normalized);
}

function hasCodEvidence(source: string): boolean {
  return /(?:cash(?:\s+on)?|pay\s+on)\s+delivery/i.test(source)
    && !isCodUnavailable(source);
}

function isCodUnavailable(source: string): boolean {
  return /(?:cash(?:\s+on)?|pay\s+on)\s+delivery.{0,80}(?:not\s+available|unavailable|disabled)/i
    .test(source.replace(/\s+/g, ' '));
}

export function buildCodCheckoutSnapshot(source: string): CodCheckoutSnapshot | undefined {
  if (!hasCodEvidence(source)) return undefined;
  const nodes = parseElements(source);
  const labels = nodes.flatMap(({ text, description }) => [description, text])
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());

  const total = extractTotal(labels);
  const address = labels.find((label) => /^delivering to\s+.+/i.test(label));
  if (total === undefined || !address) return undefined;

  const addressLabel = address
    .replace(/^delivering to\s+/i, '')
    .split(',', 1)[0]!
    .trim()
    .slice(0, 48);
  if (!addressLabel) return undefined;

  const itemNames = [...new Set(nodes
    .filter(({ resourceId }) => /\/title$/.test(resourceId ?? ''))
    .map(({ description, text }) => (description || text || '').trim())
    .filter((label) =>
      label
      && !/^(bill|cart|checkout|delivery|payment|coupon|tip|handling|platform)/i.test(label),
    ))].slice(0, 8);
  const itemCountText = labels.find((label) => /shipment of \d+ items?/i.test(label));
  const itemCount = Number(/shipment of (\d+) items?/i.exec(itemCountText ?? '')?.[1]);
  const material = {
    addressLabel,
    itemCount: Number.isInteger(itemCount) && itemCount > 0 ? itemCount : undefined,
    itemNames,
    paymentMode: 'cod' as const,
    total,
  };

  return {
    ...material,
    fingerprint: createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  };
}

function extractTotal(labels: string[]): number | undefined {
  for (const [index, label] of labels.entries()) {
    if (!/\b(?:bill|grand|order)\s+total\b/i.test(label)) continue;
    for (const candidate of [
      label,
      labels[index + 1],
      labels[index - 1],
      labels[index + 2],
      labels[index - 2],
    ]) {
      const amount = /₹\s*([\d,.]+)/.exec(candidate ?? '')?.[1];
      if (!amount) continue;
      const parsed = Number(amount.replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function parseElements(source: string): Array<{
  description?: string;
  resourceId?: string;
  text?: string;
}> {
  return [...source.matchAll(/<(?!\/|\?|!)[A-Za-z_][\w.:-]*\b([^>]*)\/?>/g)]
    .map((match) => {
      const attributes = parseAttributes(match[1] ?? '');
      return {
        description: attributes['content-desc'],
        resourceId: attributes['resource-id'],
        text: attributes.text,
      };
    });
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attributes[match[1]!] = decodeXml(match[2]!);
  }
  return attributes;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}
