import type {
  PendingInteractionV2,
  PhoneTaskStepV2,
  PhoneTaskV2,
  VerifiedFactReferenceV2,
} from './contracts';
import { parsePhoneTaskV2 } from './validation';

export type PlannerDialogueTurnV2 = {
  role: 'user' | 'assistant';
  text: string;
  at: number;
};

export type PlannerCapabilityV2 = {
  capabilityId: string;
  description: string;
};

export type PlannerContextV2 = {
  version: 2;
  task: {
    taskId: string;
    revision: number;
    originalGoal: string;
    goalKind: string;
    status: PhoneTaskV2['status'];
    activeStepId?: string;
    desiredTerminalOutcome?: PhoneTaskV2['desiredTerminalOutcome'];
  };
  graph: Array<{
    stepId: string;
    adapterId: string;
    kind: string;
    status: PhoneTaskStepV2['status'];
    dependsOn: string[];
    attempts: number;
    inputSummary: string;
    expectedPostconditionSummary: string;
  }>;
  pendingInteraction?: PendingInteractionV2;
  verifiedFacts: VerifiedFactReferenceV2[];
  observation?: {
    observationRef: string;
    summary: string;
  };
  capabilities: PlannerCapabilityV2[];
  recentDialogue: PlannerDialogueTurnV2[];
  omitted: {
    capabilities: number;
    dialogueTurns: number;
    verifiedFacts: number;
  };
  estimatedCharacters: number;
};

export class PlannerContextBudgetV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerContextBudgetV2Error';
  }
}

type PlannerContextInputV2 = {
  task: PhoneTaskV2;
  observation?: {
    observationRef: string;
    summary: string;
  };
  capabilities: readonly PlannerCapabilityV2[];
  recentDialogue: readonly PlannerDialogueTurnV2[];
};

type PlannerContextOptionsV2 = {
  maxCapabilities?: number;
  maxCharacters?: number;
  maxDialogueCharacters?: number;
  maxDialogueTurns?: number;
  maxFacts?: number;
  maxObservationCharacters?: number;
  maxStepSummaryCharacters?: number;
};

const defaults: Required<PlannerContextOptionsV2> = {
  maxCapabilities: 24,
  maxCharacters: 24_000,
  maxDialogueCharacters: 4_000,
  maxDialogueTurns: 12,
  maxFacts: 32,
  maxObservationCharacters: 2_000,
  maxStepSummaryCharacters: 500,
};

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return value.slice(0, maximum);
  return `${value.slice(0, maximum - 1)}…`;
}

function summary(value: unknown, maximum: number): string {
  const serialized = JSON.stringify(value) ?? 'null';
  return boundedText(serialized, maximum);
}

function validateOptions(
  options: PlannerContextOptionsV2,
): Required<PlannerContextOptionsV2> {
  const merged = { ...defaults, ...options };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid planner context bound ${name}.`);
    }
  }
  return merged;
}

function boundedDialogue(
  turns: readonly PlannerDialogueTurnV2[],
  maxTurns: number,
  maxCharacters: number,
): PlannerDialogueTurnV2[] {
  const selected: PlannerDialogueTurnV2[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxTurns) break;
    const turn = turns[index]!;
    if (
      !['user', 'assistant'].includes(turn.role)
      || typeof turn.text !== 'string'
      || !Number.isFinite(turn.at)
    ) {
      throw new Error('Invalid planner dialogue turn.');
    }
    const remaining = maxCharacters - used;
    if (remaining <= 0) break;
    const text = boundedText(turn.text, remaining);
    selected.unshift({ ...turn, text });
    used += text.length;
  }
  return selected;
}

export function assemblePlannerContextV2(
  input: PlannerContextInputV2,
  options: PlannerContextOptionsV2 = {},
): PlannerContextV2 {
  const bounds = validateOptions(options);
  const task = parsePhoneTaskV2(structuredClone(input.task));
  const graph = task.steps.map((step) => ({
    stepId: step.stepId,
    adapterId: step.adapterId,
    kind: step.kind,
    status: step.status,
    dependsOn: [...step.dependsOn],
    attempts: step.attempts,
    inputSummary: summary(step.input, bounds.maxStepSummaryCharacters),
    expectedPostconditionSummary: summary(
      step.expectedPostcondition,
      bounds.maxStepSummaryCharacters,
    ),
  }));
  const facts = task.verifiedFacts.slice(-bounds.maxFacts);
  const capabilities = input.capabilities
    .slice(0, bounds.maxCapabilities)
    .map((capability) => ({
      capabilityId: capability.capabilityId,
      description: boundedText(capability.description, 500),
    }));
  const recentDialogue = boundedDialogue(
    input.recentDialogue,
    bounds.maxDialogueTurns,
    bounds.maxDialogueCharacters,
  );
  const observation = input.observation
    ? {
      observationRef: input.observation.observationRef,
      summary: boundedText(
        input.observation.summary,
        bounds.maxObservationCharacters,
      ),
    }
    : undefined;
  const context: PlannerContextV2 = {
    version: 2,
    task: {
      taskId: task.taskId,
      revision: task.revision,
      originalGoal: task.originalGoal,
      goalKind: task.goalKind,
      status: task.status,
      ...(task.activeStepId ? { activeStepId: task.activeStepId } : {}),
      ...(task.desiredTerminalOutcome
        ? { desiredTerminalOutcome: structuredClone(task.desiredTerminalOutcome) }
        : {}),
    },
    graph,
    ...(task.pendingInteraction
      ? { pendingInteraction: structuredClone(task.pendingInteraction) }
      : {}),
    verifiedFacts: structuredClone(facts),
    ...(observation ? { observation } : {}),
    capabilities,
    recentDialogue,
    omitted: {
      capabilities: input.capabilities.length - capabilities.length,
      dialogueTurns: input.recentDialogue.length - recentDialogue.length,
      verifiedFacts: task.verifiedFacts.length - facts.length,
    },
    estimatedCharacters: 0,
  };
  let previousEstimate = -1;
  while (context.estimatedCharacters !== previousEstimate) {
    previousEstimate = context.estimatedCharacters;
    context.estimatedCharacters = JSON.stringify(context).length;
  }
  if (
    context.estimatedCharacters > bounds.maxCharacters
    || JSON.stringify(context).length > bounds.maxCharacters
  ) {
    throw new PlannerContextBudgetV2Error(
      'Required goal, graph, outcome, and interaction exceed the planner context budget.',
    );
  }
  return context;
}
