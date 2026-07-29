import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { buildCodCheckoutProposal } from '../../cod';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { FileCheckoutOrchestrationRepositoryV2 } from './file-orchestration-repository';
import { CheckoutOrchestrationServiceV2 } from './orchestration-service';
import { DurableCheckoutRecoveryServiceV2 } from './recovery';
import { VoiceTurnCheckoutAdapterV2 } from './voice-turn-adapter';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const roots: string[] = [];
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const authority = {
  clientId: 'android-client-1',
  ownerId: 'pixel-overlay',
  taskId,
  taskRevision: 4,
};
const money = (amount: number) => ({ amount, currency: 'INR' as const });
const checkout: AndroidCheckoutReviewV1 = {
  addressLabel: 'Home',
  addressReference: 'address_home',
  etaMinutes: 12,
  fees: [{ amount: money(5), kind: 'handling', label: 'Handling' }],
  lines: [{
    lineTotal: money(33),
    name: 'Milk',
    productId: 'milk',
    quantity: 1,
    unitPrice: money(33),
  }],
  paymentMode: 'cod',
  providerFingerprint: 'c'.repeat(64),
  total: money(38),
  unavailableItems: [],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function prepared(root: string) {
  const service = new CheckoutOrchestrationServiceV2(
    new FileCheckoutOrchestrationRepositoryV2(root),
    () => NOW,
  );
  const result = await new VoiceTurnCheckoutAdapterV2(
    service,
    () => NOW,
  ).prepareCodCheckout({
    ...authority,
    phoneResult: {
      checkout: buildCodCheckoutProposal(
        checkout,
        new Date(NOW),
        60_000,
      ),
      ok: false,
      status: 'confirmation_required',
    },
  });
  if (result.status !== 'confirmation_required') {
    throw new Error('Expected prepared checkout.');
  }
  return { result, service };
}

describe('durable checkout recovery v2', () => {
  it('discovers the exact pending review after restart without V1 state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-recovery-v2-'));
    roots.push(root);
    const first = await prepared(root);

    const restarted = new DurableCheckoutRecoveryServiceV2(
      new CheckoutOrchestrationServiceV2(
        new FileCheckoutOrchestrationRepositoryV2(root),
        () => NOW + 1,
      ),
      () => NOW + 1,
    );

    await expect(restarted.recoverLatest({
      clientId: authority.clientId,
      ownerId: authority.ownerId,
      taskId,
    })).resolves.toMatchObject({
      checkoutId: first.result.checkoutId,
      checkout: {
        proposalHash: first.result.checkout.proposalHash,
        proposalId: first.result.checkout.proposalId,
      },
      requiresFreshConfirmation: true,
      status: 'review_pending',
      taskId,
      taskRevision: authority.taskRevision,
    });
  });

  it('does not expose another owner checkout during recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-recovery-v2-'));
    roots.push(root);
    await prepared(root);
    const recovery = new DurableCheckoutRecoveryServiceV2(
      new CheckoutOrchestrationServiceV2(
        new FileCheckoutOrchestrationRepositoryV2(root),
      ),
      () => NOW + 1,
    );

    await expect(recovery.recoverLatest({
      clientId: authority.clientId,
      ownerId: 'different-overlay',
      taskId,
    })).resolves.toEqual({ status: 'missing' });
  });

  it('recovers a persisted dispatch boundary as ambiguous without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-recovery-v2-'));
    roots.push(root);
    const first = await prepared(root);
    const confirmation = await first.service.authorizeCod({
      ...authority,
      checkoutId: first.result.checkoutId,
      confirmationText: 'Confirm COD order',
      currentTerms: checkout,
      source: 'voice_coordinator',
    });
    if (!confirmation.authorized) throw new Error('Expected authorization.');
    const dispatch = await first.service.beginDispatch({
      ...authority,
      checkoutId: first.result.checkoutId,
      currentTerms: checkout,
    });
    if (!dispatch.started) throw new Error('Expected dispatch reservation.');

    const restarted = new DurableCheckoutRecoveryServiceV2(
      new CheckoutOrchestrationServiceV2(
        new FileCheckoutOrchestrationRepositoryV2(root),
      ),
      () => NOW + 1,
    );
    await expect(restarted.recoverLatest({
      clientId: authority.clientId,
      ownerId: authority.ownerId,
      taskId,
    })).resolves.toMatchObject({
      checkoutId: first.result.checkoutId,
      retryAllowed: false,
      status: 'ambiguous',
    });
  });

  it('requires a fresh review after the durable proposal expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-recovery-v2-'));
    roots.push(root);
    await prepared(root);
    const restarted = new DurableCheckoutRecoveryServiceV2(
      new CheckoutOrchestrationServiceV2(
        new FileCheckoutOrchestrationRepositoryV2(root),
      ),
      () => NOW + 60_001,
    );

    await expect(restarted.recoverLatest({
      clientId: authority.clientId,
      ownerId: authority.ownerId,
      taskId,
    })).resolves.toMatchObject({ status: 'review_expired' });
  });
});
