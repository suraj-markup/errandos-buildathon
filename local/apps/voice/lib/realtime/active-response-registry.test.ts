import { describe, expect, it, vi } from 'vitest';
import { ActiveRealtimeResponseRegistry } from './active-response-registry';

describe('active Realtime response registry', () => {
  it('cancels only a matching client/task model response', async () => {
    const registry = new ActiveRealtimeResponseRegistry();
    const cancelResponse = vi.fn(async () => true);
    registry.register({
      clientId: 'pixel-overlay',
      response: { cancelResponse },
      taskId: 'task_current',
    });

    await expect(registry.cancel({
      clientId: 'pixel-overlay',
      taskId: 'task_stale',
    })).resolves.toBe('task_mismatch');
    expect(cancelResponse).not.toHaveBeenCalled();
    await expect(registry.cancel({
      clientId: 'pixel-overlay',
      taskId: 'task_current',
    })).resolves.toBe('cancelled');
    expect(cancelResponse).toHaveBeenCalledOnce();
  });
});
