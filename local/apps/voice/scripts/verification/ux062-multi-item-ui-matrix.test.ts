import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OverlayPresentationSchemaV1 } from '@errandos/contracts';
import {
  afterAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { resolvePendingProductChoice } from '../../lib/product-choice';
import {
  buildFinalCartSummaryEventV2,
  companionIssueV2,
  RetainedTaskEventStreamV2,
} from '../../lib/progress/v2';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../lib/workflow/identifiers';
import {
  beginV2CompatibilityExecution,
  classifyIncomingTaskTurnV2,
  completeV2CompatibilityExecution,
  eligibleStepIdsV2,
  InMemoryPhoneTaskRepositoryV2,
  recoverRepositoryOnStartupV2,
  transitionPhoneTaskV2,
  type PhoneTaskV2,
  type TaskRecoveryOperationV2,
} from '../../lib/workflow/v2';
import {
  BackgroundPhoneOperationManagerV2,
} from '../../lib/workflow/v2/background-phone-operation/manager';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
} from '../../lib/workflow/v2/background-phone-operation/store';
import { validTaskV2 } from '../../lib/workflow/v2/test-fixtures';
import {
  resolveProductSelectionInteractionV2,
} from '../../lib/voice-turn/product-selection-interaction';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const operationId = parseLocalIdentifier(
  'operation',
  'operation_12345678-1234-1234-1234-123456789abc',
);
const voiceSelectionId = parseLocalIdentifier(
  'selection',
  'selection_12345678-1234-1234-1234-123456789abc',
);
const tapSelectionId = parseLocalIdentifier(
  'selection',
  'selection_87654321-4321-4321-4321-cba987654321',
);
const interactionId = 'interaction_product_choice_12345678';

const productOptions = [
  {
    offerId: 'offer_milk_500',
    product: 'Amul Taaza Toned Milk',
    size: '500 ml',
    priceAmount: 29,
    priceCurrency: 'INR' as const,
    spokenLabel: 'Amul Taaza milk',
  },
  {
    offerId: 'offer_milk_1l',
    product: 'Amul Taaza Toned Milk',
    size: '1 l',
    priceAmount: 57,
    priceCurrency: 'INR' as const,
    spokenLabel: 'Amul Taaza milk',
  },
] as const;

type MatrixRowStatus = 'FAIL' | 'PASS';

type MatrixRowResult = {
  id: string;
  requirement: string;
  status: MatrixRowStatus;
  durationMs: number;
  error?: string;
};

const matrixRows: MatrixRowResult[] = [];

async function verifyRow(
  id: string,
  requirement: string,
  assertion: () => Promise<void> | void,
): Promise<void> {
  const startedAt = performance.now();
  try {
    await assertion();
    matrixRows.push({
      id,
      requirement,
      status: 'PASS',
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  } catch (error) {
    matrixRows.push({
      id,
      requirement,
      status: 'FAIL',
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: error instanceof Error
        ? error.message.slice(0, 500)
        : 'Unknown verification failure',
    });
    throw error;
  }
}

afterAll(() => {
  const reportPath = process.env['UX062_REPORT_PATH'];
  if (!reportPath) return;
  const absolutePath = resolve(reportPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const passed = matrixRows.filter(({ status }) => status === 'PASS').length;
  writeFileSync(
    absolutePath,
    `${JSON.stringify({
      version: 1,
      suite: 'UX062 automated multi-item UI acceptance matrix',
      generatedAt: new Date().toISOString(),
      summary: {
        total: matrixRows.length,
        passed,
        failed: matrixRows.length - passed,
      },
      rows: matrixRows,
    }, null, 2)}\n`,
    'utf8',
  );
});

function productChoiceTask(): PhoneTaskV2 {
  const task = validTaskV2();
  task.taskId = taskId;
  task.clientId = 'pixel-overlay';
  task.goalKind = 'grocery';
  task.originalGoal = 'Add milk and then paneer';
  task.steps[0] = {
    ...task.steps[0]!,
    adapterId: 'blinkit',
    kind: 'search_products',
    input: {
      action: 'add_cart_item',
      request: 'Amul milk',
      quantity: 1,
    },
    expectedPostcondition: {
      kind: 'cart_contains',
      quantity: 1,
    },
  };
  return transitionPhoneTaskV2(task, {
    type: 'wait_for_user',
    stepId: 'step:first',
    entryId: 'journal:wait-for-product',
    at: 2,
    interaction: {
      interactionId,
      taskId,
      taskRevision: 1,
      kind: 'product_choice',
      allowedResponses: structuredClone(productOptions),
      presentationRef: 'presentation:milk-options',
      status: 'open',
      createdAt: 2,
      expiresAt: 100,
    },
  });
}

async function repositoryWithProductChoice(input?: {
  beforeCommit?: () => Promise<void>;
}): Promise<InMemoryPhoneTaskRepositoryV2> {
  const repository = new InMemoryPhoneTaskRepositoryV2({
    now: (): number => 10,
    ...(input?.beforeCommit
      ? { beforeCommit: (operation): Promise<void> | undefined =>
          operation === 'commit' ? input.beforeCommit?.() : undefined }
      : {}),
  });
  const task = productChoiceTask();
  await repository.create({
    task,
    event: {
      eventId: 'repository:waiting-for-product',
      taskId,
      taskRevision: task.revision,
      at: task.updatedAt,
      kind: 'waiting_for_product_choice',
    },
  });
  return repository;
}

function selectionInput(
  source: 'tap' | 'voice',
  offerId: string,
): {
  clientId: string;
  interactionId: string;
  offerId: string;
  selectionId: LocalIdentifier<'selection'>;
  source: 'tap' | 'voice';
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
} {
  return {
    clientId: 'pixel-overlay',
    interactionId,
    offerId,
    selectionId: source === 'voice' ? voiceSelectionId : tapSelectionId,
    source,
    taskId,
    taskRevision: 1,
  } as const;
}

function runningTaskWithRecoveryBoundary(
  boundary: TaskRecoveryOperationV2['boundary'],
): {
  operation: TaskRecoveryOperationV2;
  task: PhoneTaskV2;
} {
  const source = validTaskV2();
  source.taskId = taskId;
  const task = transitionPhoneTaskV2(source, {
    type: 'begin_step',
    stepId: 'step:first',
    operationId,
    entryId: 'journal:begin-for-restart',
    at: 2,
  });
  return {
    task,
    operation: {
      operationId,
      taskId,
      stepId: 'step:first',
      kind: 'add_cart_item',
      boundary,
      status: boundary === 'verified' ? 'completed' : 'running',
      ...(boundary === 'verified'
        ? { resultRef: 'result:verified-before-restart' }
        : {}),
      updatedAt: 2,
    },
  };
}

describe('UX062 automated multi-item UI acceptance matrix', () => {
  it('UX062-01 exact visible match binds one offer', () =>
    verifyRow(
      'UX062-01-exact-match',
      'An exact spoken product and pack binds one visible offer.',
      () => {
        expect(resolvePendingProductChoice(
          'Add Amul Taaza milk 500 ml',
          productOptions,
        )).toMatchObject({
          kind: 'selected',
          option: { offerId: 'offer_milk_500' },
        });
      },
    ));

  it('UX062-02 multiple matching choices remain unresolved', () =>
    verifyRow(
      'UX062-02-multiple-choices',
      'A non-unique answer does not guess between visible offers.',
      () => {
        expect(resolvePendingProductChoice(
          'Amul Taaza milk',
          productOptions,
        )).toEqual({ kind: 'ambiguous' });
      },
    ));

  it('UX062-03 voice choice resolves through the shared authority', () =>
    verifyRow(
      'UX062-03-voice-choice',
      'A voice selection binds the exact offer and durable winner metadata.',
      async () => {
        const repository = await repositoryWithProductChoice();
        const result = await resolveProductSelectionInteractionV2(
          selectionInput('voice', 'offer_milk_500'),
          { now: () => 10, repository },
        );
        expect(result).toMatchObject({
          acknowledgement: 'accepted',
          action: {
            action: 'add_cart_item',
            offerId: 'offer_milk_500',
            selectedOffer: { title: 'Amul Taaza Toned Milk' },
          },
          winner: {
            offerId: 'offer_milk_500',
            selectionId: voiceSelectionId,
            source: 'voice',
          },
        });
        expect((await repository.getById(taskId))?.task)
          .not.toHaveProperty('pendingInteraction');
      },
    ));

  it('UX062-04 card choice resolves through the same authority', () =>
    verifyRow(
      'UX062-04-card-choice',
      'A card tap binds the exact offer without a second confirmation.',
      async () => {
        const repository = await repositoryWithProductChoice();
        const result = await resolveProductSelectionInteractionV2(
          selectionInput('tap', 'offer_milk_1l'),
          { now: () => 10, repository },
        );
        expect(result).toMatchObject({
          acknowledgement: 'accepted',
          action: {
            action: 'add_cart_item',
            offerId: 'offer_milk_1l',
          },
          winner: {
            offerId: 'offer_milk_1l',
            selectionId: tapSelectionId,
            source: 'tap',
          },
        });
      },
    ));

  it('UX062-05 duplicate and voice/tap race have one winner', () =>
    verifyRow(
      'UX062-05-duplicate-race',
      'Concurrent voice and tap choices commit once; exact replay is duplicate.',
      async () => {
        let commitsEntered = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        const repository = await repositoryWithProductChoice({
          beforeCommit: async () => {
            commitsEntered += 1;
            if (commitsEntered === 2) release();
            await gate;
          },
        });
        const voiceInput = selectionInput('voice', 'offer_milk_500');
        const tapInput = selectionInput('tap', 'offer_milk_1l');
        const outcomes = await Promise.all([
          resolveProductSelectionInteractionV2(
            voiceInput,
            { now: () => 10, repository },
          ),
          resolveProductSelectionInteractionV2(
            tapInput,
            { now: () => 10, repository },
          ),
        ]);
        expect(outcomes.filter(
          ({ acknowledgement }) => acknowledgement === 'accepted',
        )).toHaveLength(1);
        expect(outcomes.filter(
          ({ acknowledgement }) => acknowledgement === 'rejected',
        )).toHaveLength(1);
        const accepted = outcomes.find(
          ({ acknowledgement }) => acknowledgement === 'accepted',
        );
        expect(accepted?.acknowledgement).toBe('accepted');
        const winnerInput = accepted?.acknowledgement === 'accepted'
          && accepted.winner.source === 'voice'
          ? voiceInput
          : tapInput;
        expect(await resolveProductSelectionInteractionV2(
          winnerInput,
          { now: () => 10, repository },
        )).toMatchObject({
          acknowledgement: 'duplicate',
          winner: accepted?.acknowledgement === 'accepted'
            ? accepted.winner
            : undefined,
        });
        expect((await repository.getById(taskId))?.task.revision).toBe(2);
      },
    ));

  it('UX062-06 slow accepted operation projects a visual heartbeat', () =>
    verifyRow(
      'UX062-06-slow-heartbeat',
      'Accepted background work stays running and gains a visual-only heartbeat.',
      async () => {
        let now = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        const worker = vi.fn(async () => {
          await gate;
          return { outcome: 'completed' as const };
        });
        const stream = new RetainedTaskEventStreamV2({
          heartbeatAfterMs: 10_000,
          now: (): number => now,
        });
        const manager = new BackgroundPhoneOperationManagerV2({
          now: (): number => now,
          store: new InMemoryBackgroundPhoneOperationStoreV2(),
          stream,
          worker,
          newOperationId: (): LocalIdentifier<'operation'> => operationId,
        });
        const accepted = await manager.enqueue({
          taskId,
          taskRevision: 2,
          stepId: 'step:first',
          operationKind: 'add_cart_item',
          requestPayload: { version: 1, offerId: 'offer_milk_500' },
        });
        await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
        expect(accepted).toMatchObject({
          disposition: 'enqueued',
          operationAccepted: { status: 'accepted', operationId },
        });
        now = 10_500;
        expect(stream.readAfter({
          afterSequence: 0,
          taskId,
        })).toMatchObject({
          events: [],
          heartbeat: {
            sourceSequence: 0,
            elapsedMs: 10_500,
            announcement: { channel: 'visual_only' },
          },
        });
        release();
        await manager.awaitIdle();
      },
    ));

  it('UX062-07 ambiguity halts the dependent queue', () =>
    verifyRow(
      'UX062-07-ambiguity-halts',
      'An attempted-but-unverified mutation blocks the next item and requires reconciliation.',
      async () => {
        const repository = new InMemoryPhoneTaskRepositoryV2({
          now: (): number => 10,
        });
        const source = validTaskV2();
        source.taskId = taskId;
        await repository.create({
          task: source,
          event: {
            eventId: 'repository:ambiguity-source',
            taskId,
            taskRevision: 0,
            at: 1,
            kind: 'task_created',
          },
        });
        const running = await beginV2CompatibilityExecution({
          at: 2,
          operationId,
          repository,
          stepId: 'step:first',
          task: source,
        });
        const ambiguous = await completeV2CompatibilityExecution({
          at: 3,
          operationId,
          repository,
          result: {
            ok: false,
            status: 'execution_failed',
            verification: { mutationAttempted: true },
          },
          stepId: 'step:first',
          task: running.task,
        });
        expect(ambiguous.task).toMatchObject({
          status: 'ambiguous',
          steps: [
            { status: 'ambiguous' },
            { status: 'planned' },
          ],
        });
        expect(eligibleStepIdsV2(ambiguous.task)).toEqual([]);
        expect(classifyIncomingTaskTurnV2(ambiguous.task, {
          kind: 'addition',
          additionRef: 'patch:add-rice',
        })).toEqual({
          action: 'reject',
          reason: 'reconciliation_required',
        });
      },
    ));

  it('UX062-08 disconnect exposes only safe recovery actions', () =>
    verifyRow(
      'UX062-08-disconnect',
      'A disconnected phone pauses the task and never offers a blind mutation retry.',
      () => {
        const issue = companionIssueV2({
          version: 2,
          stage: 'adb_device',
          status: 'disconnected',
        });
        expect(issue).toMatchObject({
          code: 'phone_disconnected',
          queueBehavior: 'pause_task',
          recoveryActions: [
            { actionId: 'reconnect_phone', safety: 'read_only' },
            { actionId: 'stop_task', safety: 'stop_only' },
          ],
        });
        expect(issue.recoveryActions).not.toEqual(expect.arrayContaining([
          expect.objectContaining({
            actionId: 'retry_verified_not_applied',
          }),
        ]));
      },
    ));

  it('UX062-09 restart reconciles once and resumes from authoritative state', () =>
    verifyRow(
      'UX062-09-restart',
      'Restart after a mutation boundary reconciles once and advances once.',
      async () => {
        const sourceRepository = new InMemoryPhoneTaskRepositoryV2({
          now: (): number => 10,
        });
        const source = runningTaskWithRecoveryBoundary(
          'mutation_attempted',
        );
        await sourceRepository.create({
          task: source.task,
          event: {
            eventId: 'repository:running-before-restart',
            taskId,
            taskRevision: source.task.revision,
            at: 2,
            kind: 'execution_began',
          },
          activeOperation: source.operation,
        });
        const restarted = new InMemoryPhoneTaskRepositoryV2({
          now: (): number => 11,
        });
        await restarted.restoreSnapshot(
          await sourceRepository.exportSnapshot(),
        );
        const reconcile = vi.fn().mockResolvedValue({
          outcome: 'verified_applied',
          evidenceRef: 'evidence:fresh-cart',
        });
        const reports = await recoverRepositoryOnStartupV2({
          repository: restarted,
          reconciler: { reconcile },
          now: () => 12,
        });
        expect(reconcile).toHaveBeenCalledOnce();
        expect(reports).toEqual([
          expect.objectContaining({ outcome: 'mutation_verified' }),
        ]);
        expect((await restarted.getById(taskId))?.task.steps).toMatchObject([
          { status: 'verified' },
          { status: 'ready' },
        ]);
      },
    ));

  it('UX062-10 skip clears the choice and advances without mutation', () =>
    verifyRow(
      'UX062-10-skip',
      'Skipping the current choice clears it and makes the next item ready.',
      () => {
        const waiting = productChoiceTask();
        const skipped = transitionPhoneTaskV2(waiting, {
          type: 'skip_step',
          stepId: 'step:first',
          entryId: 'journal:skip-current-product',
          at: 3,
        });
        expect(skipped).toMatchObject({
          status: 'active',
          steps: [
            { status: 'skipped', attempts: 0 },
            { status: 'ready', attempts: 0 },
          ],
        });
        expect(skipped.pendingInteraction).toBeUndefined();
        expect(skipped.journal.some(
          ({ type }) => type === 'begin_step',
        )).toBe(false);
      },
    ));

  it('UX062-11 edit invalidates the stale product choice', () =>
    verifyRow(
      'UX062-11-edit-invalidates-choice',
      'Editing a waiting item clears its old choice and rejects the stale answer.',
      async () => {
        const repository = await repositoryWithProductChoice();
        const waiting = (await repository.getById(taskId))!.task;
        const replacement = transitionPhoneTaskV2(waiting, {
          type: 'replace_step',
          stepId: 'step:first',
          entryId: 'journal:replace-milk-with-oat-milk',
          at: 3,
          replacement: {
            adapterId: 'blinkit',
            kind: 'search_products',
            status: 'planned',
            dependsOn: [],
            input: {
              action: 'add_cart_item',
              request: 'oat milk',
              quantity: 1,
            },
            expectedPostcondition: {
              kind: 'cart_contains',
              quantity: 1,
            },
            attempts: 0,
          },
        });
        await repository.commit({
          expectedRevision: waiting.revision,
          task: replacement,
          event: {
            eventId: 'repository:replace-milk-with-oat-milk',
            taskId,
            taskRevision: replacement.revision,
            at: replacement.updatedAt,
            kind: 'step_replaced',
          },
        });
        expect(replacement.pendingInteraction).toBeUndefined();
        expect(replacement.steps[0]?.input).toMatchObject({
          request: 'oat milk',
        });
        expect(await resolveProductSelectionInteractionV2(
          selectionInput('tap', 'offer_milk_500'),
          { now: () => 10, repository },
        )).toMatchObject({
          acknowledgement: 'rejected',
          reason: 'stale_task_revision',
        });
      },
    ));

  it('UX062-12 completion is strict verified cart truth without continuation or checkout', () =>
    verifyRow(
      'UX062-12-strict-completion',
      'Completion renders verified NOT ORDERED cart truth and no phantom next action.',
      () => {
        const event = buildFinalCartSummaryEventV2({
          inspectedAt: 190,
          inspection: {
            status: 'cart_status',
            cart: {
              addressLabel: 'Home',
              verified: true,
              ordered: false,
              lines: [{
                productId: 'paneer_200g',
                product: 'Amul Fresh Malai Paneer',
                spokenLabel: 'Amul paneer',
                packSize: '200 g',
                quantity: 2,
                price: '₹105',
              }],
              subtotal: '₹210',
            },
          },
          operationId,
          taskId,
          taskRevision: 8,
        });
        expect(OverlayPresentationSchemaV1.safeParse(event.safePresentation))
          .toMatchObject({ success: true });
        expect(event).toMatchObject({
          kind: 'completed',
          terminal: true,
          finalCartSummary: {
            status: 'ready',
            subtotal: '₹210',
          },
          safePresentation: {
            card: {
              type: 'cart_summary',
              ordered: false,
              cart: {
                verified: true,
                subtotal: { amount: 210, currency: 'INR' },
              },
            },
          },
        });
        expect(event.interaction).toBeUndefined();
        expect(JSON.stringify(event)).not.toMatch(
          /continue|review_checkout|confirm_order|place_order|order_now/i,
        );
      },
    ));
});
