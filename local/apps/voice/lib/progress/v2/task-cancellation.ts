import type { LocalIdentifier } from '../../workflow/identifiers';
import type { SemanticTaskEventV2 } from './contracts';
import type {
  RetainedTaskEventStreamV2,
} from './retained-task-event-stream';

export function ensureTaskCancelledEventV2(input: {
  detail?: string;
  stream: RetainedTaskEventStreamV2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  title?: string;
}): SemanticTaskEventV2 {
  return input.stream.publish({
    dedupeKey: `task-cancelled:${input.taskRevision}`,
    kind: 'cancelled',
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    terminal: true,
    title: input.title?.trim() || 'Task cancelled',
    detail: input.detail?.trim() || 'The task was cancelled.',
    announcement: {
      channel: 'visual_only',
      text: 'Task cancelled.',
    },
  });
}
