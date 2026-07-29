import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

const progressGlobal = globalThis as typeof globalThis & {
  errandosTaskEventStreamV2?: RetainedTaskEventStreamV2;
};

progressGlobal.errandosTaskEventStreamV2 ??=
  new RetainedTaskEventStreamV2();

export const taskEventStreamV2 =
  progressGlobal.errandosTaskEventStreamV2;
