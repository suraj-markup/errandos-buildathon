import {
  BlinkitCheckoutBlockedOutputSchemaV1,
  type BlinkitCheckoutBlockedOutputV1,
  type BlinkitCheckoutBlockedReasonV1,
} from '@errandos/contracts';

export interface BlinkitCodMinimumDetails {
  itemSubtotal: number;
  requiredSubtotal: number;
}

export class BlinkitCheckoutBlockedError extends Error {
  public readonly reason: BlinkitCheckoutBlockedReasonV1;
  public readonly details?: BlinkitCodMinimumDetails;

  public constructor(reason: BlinkitCheckoutBlockedReasonV1, details?: BlinkitCodMinimumDetails) {
    const parsed = BlinkitCheckoutBlockedOutputSchemaV1.parse({
      version: 1,
      provider: 'blinkit',
      status: 'blocked',
      reason,
      ...(details ?? {}),
    });
    super(`Blinkit checkout blocked: ${parsed.reason}`);
    this.name = 'BlinkitCheckoutBlockedError';
    this.reason = parsed.reason;
    if (parsed.itemSubtotal !== undefined && parsed.requiredSubtotal !== undefined) {
      this.details = {
        itemSubtotal: parsed.itemSubtotal,
        requiredSubtotal: parsed.requiredSubtotal,
      };
    }
  }

  public toOutput(): BlinkitCheckoutBlockedOutputV1 {
    return BlinkitCheckoutBlockedOutputSchemaV1.parse({
      version: 1,
      provider: 'blinkit',
      status: 'blocked',
      reason: this.reason,
      ...(this.details ?? {}),
    });
  }
}

export function parseCodMinimumConstraint(source: string, itemSubtotal: number): BlinkitCodMinimumDetails | undefined {
  if (!Number.isFinite(itemSubtotal) || itemSubtotal < 0) return undefined;
  const normalized = source.replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const codMentioned = /(?:cash(?:\s+on)?|pay\s+on)\s+delivery/i.test(normalized);
  if (!codMentioned) return undefined;

  const direct = [
    /(?:cash(?:\s+on)?|pay\s+on)\s+delivery.{0,160}?(?:minimum|order\s+value|cart\s+value|subtotal|above|over|at\s+least|below).{0,80}?₹\s*([\d,.]+)/i,
    /₹\s*([\d,.]+).{0,80}?(?:minimum|order\s+value|cart\s+value|subtotal|above|over|at\s+least|below).{0,160}?(?:cash(?:\s+on)?|pay\s+on)\s+delivery/i,
  ].map((pattern) => amount(pattern.exec(normalized)?.[1])).find((value): value is number => value !== undefined);
  if (direct !== undefined && direct > itemSubtotal) {
    return { itemSubtotal, requiredSubtotal: direct };
  }

  const remaining = [
    /(?:cash(?:\s+on)?|pay\s+on)\s+delivery.{0,160}?add.{0,80}?₹\s*([\d,.]+)\s+more/i,
    /add.{0,80}?₹\s*([\d,.]+)\s+more.{0,160}?(?:cash(?:\s+on)?|pay\s+on)\s+delivery/i,
  ].map((pattern) => amount(pattern.exec(normalized)?.[1])).find((value): value is number => value !== undefined);
  if (remaining !== undefined && remaining > 0) {
    return { itemSubtotal, requiredSubtotal: itemSubtotal + remaining };
  }
  return undefined;
}

function amount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
