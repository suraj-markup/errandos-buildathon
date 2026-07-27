import type { PrincipalId } from '@errandos/contracts';
import type { DurableProviderState } from '../runtime/provider-state.js';

type Money = { currency: 'INR'; amount: number };
export interface BlinkitOrderLine { productId: string; quantity: number }
export interface BlinkitOrderExpectation {
  providerReference?: string;
  notBefore: string;
  notAfter: string;
  total: Money;
  addressSummary: string;
  deliveryLocationReference?: string;
  lines: BlinkitOrderLine[];
}
export interface BlinkitOrderCandidate {
  providerReference: string;
  orderedAt: string;
  total: Money;
  addressSummary: string;
  deliveryLocationReference?: string;
  lines: BlinkitOrderLine[];
}
export interface BlinkitOrderHistoryPort {
  openOrderHistory(): Promise<void>;
  extractOrders(): Promise<BlinkitOrderCandidate[]>;
  close(): Promise<void>;
}

const stableLines = (lines: readonly BlinkitOrderLine[]): string => JSON.stringify([...lines].sort((left, right) => left.productId.localeCompare(right.productId)));

export function extractBlinkitOrderCandidates(html: string): BlinkitOrderCandidate[] {
  const candidates: BlinkitOrderCandidate[] = [];
  for (const match of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const attribute = (name: string): string | undefined => new RegExp(`${name}=["']([^"']+)["']`, 'i').exec(attributes)?.[1];
    const providerReference = /order\s*(?:id|no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9-]{6,})/i.exec(plain)?.[1];
    const orderedAt = attribute('data-ordered-at');
    const total = /total[^₹]{0,40}₹\s*([\d,]+(?:\.\d+)?)/i.exec(plain)?.[1];
    const addressSummary = /delivered\s+to\s+(.+?)(?:\s{2,}|$)/i.exec(plain)?.[1]?.trim();
    const lines = [...body.matchAll(/<[^>]*data-product-id=["']([^"']+)["'][^>]*data-quantity=["'](\d+)["'][^>]*>/gi)].map((line) => ({ productId: line[1]!, quantity: Number(line[2]) }));
    if (!providerReference || !orderedAt || !total || !addressSummary || lines.length === 0) continue;
    const addressReference = attribute('data-address-ref');
    candidates.push({ providerReference, orderedAt, total: { currency: 'INR', amount: Number(total.replaceAll(',', '')) }, addressSummary, ...(addressReference ? { deliveryLocationReference: addressReference } : {}), lines });
  }
  return candidates;
}

export function findUniqueMatchingOrder(expected: BlinkitOrderExpectation, candidates: readonly BlinkitOrderCandidate[]): BlinkitOrderCandidate | undefined {
  const matches = expected.providerReference
    ? candidates.filter(({ providerReference }) => providerReference === expected.providerReference)
    : candidates.filter((candidate) => {
      const time = Date.parse(candidate.orderedAt);
      const locationMatches = expected.deliveryLocationReference
        ? candidate.deliveryLocationReference === expected.deliveryLocationReference
        : candidate.addressSummary === expected.addressSummary;
      return Number.isFinite(time)
        && time >= Date.parse(expected.notBefore)
        && time <= Date.parse(expected.notAfter)
        && candidate.total.currency === expected.total.currency
        && candidate.total.amount === expected.total.amount
        && locationMatches
        && stableLines(candidate.lines) === stableLines(expected.lines);
    });
  if (matches.length > 1) throw new Error('ambiguous Blinkit order-history match');
  return matches[0];
}

function parseState(value: unknown): { accountKey: string; expectation: BlinkitOrderExpectation } {
  if (!value || typeof value !== 'object') throw new Error('invalid Blinkit reconciliation state');
  const state = value as { provider?: unknown; accountKey?: unknown; expectation?: BlinkitOrderExpectation };
  if (state.provider !== 'blinkit' || typeof state.accountKey !== 'string' || !state.expectation) throw new Error('invalid Blinkit reconciliation state');
  return { accountKey: state.accountKey, expectation: state.expectation };
}

export class BlinkitReadOnlyReconciler {
  public constructor(
    private readonly state: Pick<DurableProviderState, 'get'>,
    private readonly history: (accountKey: string) => Promise<BlinkitOrderHistoryPort>,
  ) {}

  public async reconcile(owner: PrincipalId, providerStateRef: string): Promise<{ outcome: 'committed'; providerReference: string } | { outcome: 'pending' }> {
    const persisted = parseState(await this.state.get(owner, providerStateRef));
    const history = await this.history(persisted.accountKey);
    try {
      await history.openOrderHistory();
      const matched = findUniqueMatchingOrder(persisted.expectation, await history.extractOrders());
      return matched ? { outcome: 'committed', providerReference: matched.providerReference } : { outcome: 'pending' };
    } catch { return { outcome: 'pending' }; }
    finally { await history.close().catch(() => undefined); }
  }
}
