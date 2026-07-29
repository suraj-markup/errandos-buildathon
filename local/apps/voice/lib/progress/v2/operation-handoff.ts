import type { LocalIdentifier } from '../../workflow/identifiers';
import {
  createOperationAcceptedV2,
} from './operation-acknowledgement';
import type {
  OperationAcceptedV2,
  SemanticTaskEventV2,
  TaskEventItemV2,
  TaskEventProgressV2,
} from './contracts';
import type {
  RetainedTaskEventStreamV2,
} from './retained-task-event-stream';

export type RetainedOperationHandoffV2 = {
  operationAccepted: OperationAcceptedV2;
  retainedEvent: SemanticTaskEventV2;
};

export function createRetainedOperationHandoffV2(input: {
  compatibilityDeadlineMs?: number;
  item?: TaskEventItemV2;
  operationId: LocalIdentifier<'operation'>;
  progress?: TaskEventProgressV2;
  stepId?: string;
  stream: RetainedTaskEventStreamV2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  title?: string;
}): RetainedOperationHandoffV2 {
  const retainedEvent = input.stream.publish({
    dedupeKey: `${input.operationId}:accepted`,
    kind: 'step_started',
    operationId: input.operationId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.item ? { item: input.item } : {}),
    ...(input.progress ? { progress: input.progress } : {}),
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    title: input.title?.trim() || 'Phone operation accepted',
    detail: 'Progress will continue on the retained task stream.',
    announcement: {
      channel: 'visual_only',
      text: 'Phone operation accepted.',
    },
  });
  return {
    operationAccepted: createOperationAcceptedV2({
      afterSequence: retainedEvent.sequence,
      ...(input.compatibilityDeadlineMs === undefined
        ? {}
        : {
            compatibilityDeadlineMs: input.compatibilityDeadlineMs,
          }),
      operationId: input.operationId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
    }),
    retainedEvent,
  };
}
