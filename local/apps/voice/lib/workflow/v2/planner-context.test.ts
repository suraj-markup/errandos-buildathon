import { describe, expect, it } from 'vitest';
import {
  PlannerContextBudgetV2Error,
  assemblePlannerContextV2,
} from './planner-context';
import { validTaskV2 } from './test-fixtures';

describe('PhoneTaskV2 planner context assembler', () => {
  it('truncates dialogue without losing the complete goal or graph', () => {
    const task = validTaskV2();
    task.originalGoal =
      'Add milk, bread, eggs, and cereal, then review checkout using COD';
    task.desiredTerminalOutcome = {
      kind: 'checkout_reviewed',
      paymentPreference: 'cod',
    };
    const dialogue = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `turn-${index}-${'x'.repeat(80)}`,
      at: index,
    }));

    const context = assemblePlannerContextV2({
      task,
      capabilities: Array.from({ length: 8 }, (_, index) => ({
        capabilityId: `capability:${index}`,
        description: `Capability ${index}`,
      })),
      recentDialogue: dialogue,
      observation: {
        observationRef: 'observation:one',
        summary: 'A current screen observation',
      },
    }, {
      maxCapabilities: 3,
      maxDialogueCharacters: 250,
      maxDialogueTurns: 4,
      maxCharacters: 8_000,
    });

    expect(context.task.originalGoal).toBe(task.originalGoal);
    expect(context.task.desiredTerminalOutcome).toEqual({
      kind: 'checkout_reviewed',
      paymentPreference: 'cod',
    });
    expect(context.graph.map((step) => step.stepId))
      .toEqual(['step:first', 'step:second']);
    expect(context.recentDialogue.length).toBeLessThanOrEqual(4);
    expect(context.recentDialogue.at(-1)?.text).toContain('turn-19');
    expect(context.omitted).toMatchObject({ capabilities: 5 });
    expect(context.omitted.dialogueTurns)
      .toBe(dialogue.length - context.recentDialogue.length);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(8_000);
  });

  it('always retains the pending interaction and checkout continuation', () => {
    const task = validTaskV2();
    task.status = 'waiting_for_user';
    task.desiredTerminalOutcome = {
      kind: 'checkout_reviewed',
      paymentPreference: 'cod',
    };
    task.pendingInteraction = {
      interactionId: 'interaction:checkout',
      taskId: task.taskId,
      taskRevision: task.revision,
      kind: 'checkout_confirmation',
      allowedResponses: ['confirm', 'cancel'],
      presentationRef: 'presentation:checkout',
      status: 'open',
      createdAt: 1,
      expiresAt: 100,
    };

    const context = assemblePlannerContextV2({
      task,
      capabilities: [],
      recentDialogue: Array.from({ length: 50 }, (_, index) => ({
        role: 'user' as const,
        text: `old history ${index}`,
        at: index,
      })),
    }, {
      maxDialogueTurns: 1,
      maxCharacters: 8_000,
    });

    expect(context.pendingInteraction?.interactionId).toBe('interaction:checkout');
    expect(context.task.desiredTerminalOutcome?.kind).toBe('checkout_reviewed');
  });

  it('fails closed rather than truncate required task truth', () => {
    expect(() => assemblePlannerContextV2({
      task: validTaskV2(),
      capabilities: [],
      recentDialogue: [],
    }, {
      maxCharacters: 50,
    })).toThrow(PlannerContextBudgetV2Error);
  });
});
