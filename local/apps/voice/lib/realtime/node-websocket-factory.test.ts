import { describe, expect, it } from 'vitest';
import { createNodeRealtimeSocket } from './node-websocket-factory';

describe('server Realtime WebSocket factory', () => {
  it('is a callable server-only socket factory', () => {
    expect(typeof createNodeRealtimeSocket).toBe('function');
  });
});
