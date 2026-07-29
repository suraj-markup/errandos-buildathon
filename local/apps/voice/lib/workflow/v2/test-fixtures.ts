import {
  DEFAULT_TASK_BUDGETS_V2,
  PHONE_TASK_V2_VERSION,
  type PhoneTaskV2,
} from './contracts';

export function validTaskV2(): PhoneTaskV2 {
  return {
    version: PHONE_TASK_V2_VERSION,
    taskId: 'task:v2:test',
    clientId: 'pixel-overlay',
    revision: 0,
    originalGoal: 'Do the first thing and then the second thing',
    goalKind: 'general_phone_task',
    status: 'active',
    activeStepId: 'step:first',
    steps: [
      {
        stepId: 'step:first',
        adapterId: 'test-adapter',
        kind: 'first_action',
        status: 'ready',
        dependsOn: [],
        input: { target: 'first' },
        expectedPostcondition: { state: 'done' },
        attempts: 0,
      },
      {
        stepId: 'step:second',
        adapterId: 'test-adapter',
        kind: 'second_action',
        status: 'planned',
        dependsOn: ['step:first'],
        input: { target: 'second' },
        expectedPostcondition: { state: 'done' },
        attempts: 0,
      },
    ],
    desiredTerminalOutcome: { kind: 'goal_satisfied' },
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: 1,
    updatedAt: 1,
  };
}
