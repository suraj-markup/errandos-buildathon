import WebSocket from 'ws';
import type {
  RealtimeSocketFactory,
  RealtimeWebSocketLike,
} from './websocket-transport';

/**
 * Creates a trusted-server WebSocket. Authentication headers remain inside
 * the Next.js process and are never serialized into the Android protocol.
 */
export const createNodeRealtimeSocket: RealtimeSocketFactory = ({
  headers,
  signal,
  url,
}) => {
  const socket = new WebSocket(url, { headers });
  const abort = () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    socket.close(1000, 'request aborted');
  };
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('close', () => {
      signal.removeEventListener('abort', abort);
    }, { once: true });
  }
  return socket as unknown as RealtimeWebSocketLike;
};
