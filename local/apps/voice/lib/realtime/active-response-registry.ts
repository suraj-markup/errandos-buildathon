import type { RealtimeResponseController } from './cancellation-domains';

type ActiveResponse = {
  response: RealtimeResponseController;
  taskId: string;
};

/**
 * Process-local cancellation index used by the PTT interrupt endpoint.
 * It contains no phone-operation controller, so this boundary cannot cancel a
 * queued or in-flight device mutation.
 */
export class ActiveRealtimeResponseRegistry {
  private readonly active = new Map<string, ActiveResponse>();

  register(input: {
    clientId: string;
    response: RealtimeResponseController;
    taskId: string;
  }): () => void {
    const entry = {
      response: input.response,
      taskId: input.taskId,
    };
    this.active.set(input.clientId, entry);
    return () => {
      if (this.active.get(input.clientId) === entry) {
        this.active.delete(input.clientId);
      }
    };
  }

  async cancel(input: {
    clientId: string;
    taskId?: string;
  }): Promise<'cancelled' | 'idle' | 'task_mismatch'> {
    const active = this.active.get(input.clientId);
    if (!active) return 'idle';
    if (input.taskId && input.taskId !== active.taskId) {
      return 'task_mismatch';
    }
    return await active.response.cancelResponse() ? 'cancelled' : 'idle';
  }
}

const globalRegistry = globalThis as typeof globalThis & {
  errandosActiveRealtimeResponses?: ActiveRealtimeResponseRegistry;
};

export const activeRealtimeResponseRegistry =
  globalRegistry.errandosActiveRealtimeResponses
  ?? new ActiveRealtimeResponseRegistry();
globalRegistry.errandosActiveRealtimeResponses = activeRealtimeResponseRegistry;
