import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { buildCodCheckoutProposal } from '../../cod';
import { FileCheckoutOrchestrationRepositoryV2 } from './file-orchestration-repository';
import { CheckoutOrchestrationServiceV2 } from './orchestration-service';
import { VoiceTurnCheckoutAdapterV2 } from './voice-turn-adapter';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const roots: string[] = [];
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

describe('file checkout orchestration repository v2', () => {
  it('restores persisted transitions into a new service instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-v2-'));
    roots.push(root);
    const first = new CheckoutOrchestrationServiceV2(
      new FileCheckoutOrchestrationRepositoryV2(root),
      () => NOW,
    );
    const opened = await first.open({
      checkoutId: 'checkout_restart_1',
      clientId: 'android-client-1',
      ownerId: 'pixel-overlay',
      taskId,
      taskRevision: 4,
      codAvailable: true,
      currentPayment: {
        kind: 'card',
        label: 'Mastercard',
        methodRef: 'provider_payment_1',
      },
      originalGoalIncludesOrder: true,
    });
    await first.presentPaymentOptions({
      checkoutId: opened.checkoutId,
      expiresAt: NOW + 60_000,
      interactionId: 'payment_restart_1',
    });

    const restarted = new CheckoutOrchestrationServiceV2(
      new FileCheckoutOrchestrationRepositoryV2(root),
      () => NOW + 1,
    );
    await expect(restarted.get(opened.checkoutId)).resolves.toMatchObject({
      recordRevision: 1,
      graph: { activeNode: 'choose_payment_method' },
      paymentPresentation: { interactionId: 'payment_restart_1' },
      events: [
        { kind: 'checkout_opened' },
        { kind: 'payment_options_presented' },
      ],
    });
  });

  it('fails closed when a persisted record is modified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-v2-'));
    roots.push(root);
    const repository = new FileCheckoutOrchestrationRepositoryV2(root);
    const service = new CheckoutOrchestrationServiceV2(
      repository,
      () => NOW,
    );
    const opened = await service.open({
      checkoutId: 'checkout_corrupt_1',
      clientId: 'android-client-1',
      ownerId: 'pixel-overlay',
      taskId,
      taskRevision: 4,
      codAvailable: true,
      currentPayment: {
        kind: 'card',
        label: 'Mastercard',
        methodRef: 'provider_payment_1',
      },
      originalGoalIncludesOrder: true,
    });
    const path = join(root, `${opened.checkoutId}.json`);
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    envelope.record.taskRevision = 99;
    await writeFile(path, JSON.stringify(envelope), 'utf8');

    await expect(repository.get(opened.checkoutId))
      .rejects.toThrow('checksum');
  });

  it('recovers a persisted dispatch reservation as ambiguity without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkout-v2-'));
    roots.push(root);
    const authority = {
      clientId: 'android-client-1',
      ownerId: 'pixel-overlay',
      taskId,
      taskRevision: 4,
    };
    const firstService = new CheckoutOrchestrationServiceV2(
      new FileCheckoutOrchestrationRepositoryV2(root),
      () => NOW,
    );
    const firstAdapter = new VoiceTurnCheckoutAdapterV2(
      firstService,
      () => NOW,
    );
    const prepared = await firstAdapter.prepareCodCheckout({
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
    if (prepared.status !== 'confirmation_required') {
      throw new Error('Expected prepared checkout.');
    }
    const authorized = await firstService.authorizeCod({
      ...authority,
      checkoutId: prepared.checkoutId,
      confirmationText: 'Confirm COD order',
      currentTerms: checkout,
      source: 'voice_coordinator',
    });
    if (!authorized.authorized) throw new Error('Expected authorization.');
    const started = await firstService.beginDispatch({
      ...authority,
      checkoutId: prepared.checkoutId,
      currentTerms: checkout,
    });
    if (!started.started) throw new Error('Expected dispatch reservation.');

    const restartedService = new CheckoutOrchestrationServiceV2(
      new FileCheckoutOrchestrationRepositoryV2(root),
      () => NOW + 1,
    );
    const restartedAdapter = new VoiceTurnCheckoutAdapterV2(
      restartedService,
      () => NOW + 1,
    );
    let commits = 0;
    await expect(restartedAdapter.confirmCodCheckout({
      ...authority,
      checkoutId: prepared.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => checkout,
      commit: async () => {
        commits += 1;
        return { ok: true, status: 'ordered' };
      },
    })).resolves.toMatchObject({
      reconciliationRequired: true,
      retryAllowed: false,
      status: 'order_status_ambiguous',
    });
    expect(commits).toBe(0);
    await expect(restartedService.get(prepared.checkoutId)).resolves
      .toMatchObject({
        graph: {
          phase: 'ambiguous',
          dispatchAttempts: 1,
          activeNode: 'reconcile_order',
        },
      });
  });
});
