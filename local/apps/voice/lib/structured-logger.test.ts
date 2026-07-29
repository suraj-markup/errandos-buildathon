import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logEvent,
  sanitizeLogData,
  traceFunction,
  withLogContext,
} from './structured-logger';
import {
  StageDeadlineExceededError,
  stageTimeoutOutcome,
} from './stage-deadlines';

describe('structured logger', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['provider.sarvam.transcribe', 20_000, 'sarvam_stt'],
    ['provider.openai.responses', 15_000, 'control_model'],
    ['provider.sarvam.synthesize', 15_000, 'sarvam_tts'],
  ] as const)(
    'applies an independent deadline to %s',
    async (functionName, timeoutMs, stage) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const pending = traceFunction(
        functionName,
        {},
        async () => new Promise(() => undefined),
      );
      const outcome = pending.catch((value) => value);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      const error = await outcome;
      expect(error).toBeInstanceOf(StageDeadlineExceededError);
      expect(stageTimeoutOutcome(error)).toMatchObject({
        recoveryAction: 'retry_safe',
        stage,
        status: 'stage_timeout',
        timeoutMs,
      });
    },
  );

  it('redacts secrets and sensitive transaction fields', () => {
    expect(sanitizeLogData({
      apiKey: 'secret',
      authorization: 'Bearer secret',
      expectedFingerprint: 'abc',
      transcript: 'add private milk',
      reply: 'private assistant prose',
      toolArguments: { request: 'private product' },
      imageBytes: 'private-image',
      nested: {
        addressLabel: 'Home',
        offerId: 'offer-123',
      },
    })).toEqual({
      apiKey: '[redacted]',
      authorization: '[redacted]',
      expectedFingerprint: '[redacted]',
      transcript: '[redacted]',
      reply: '[redacted]',
      toolArguments: '[redacted]',
      imageBytes: '[redacted]',
      nested: {
        addressLabel: '[redacted]',
        offerId: 'offer-123',
      },
    });
  });

  it('reveals local request and response content without exposing secrets', () => {
    vi.stubEnv('JALDI_LOG_CONTENT_V1', 'true');
    vi.stubEnv('NODE_ENV', 'development');

    expect(sanitizeLogData({
      apiKey: 'secret',
      audioBytes: 1234,
      reply: 'Added the milk.',
      transcript: 'Add this milk.',
      toolArguments: {
        request: 'Amul Taaza 500 ml',
        paymentMode: 'Cash on Delivery',
      },
    })).toEqual({
      apiKey: '[redacted]',
      audioBytes: '[redacted]',
      reply: 'Added the milk.',
      transcript: 'Add this milk.',
      toolArguments: {
        request: 'Amul Taaza 500 ml',
        paymentMode: '[redacted]',
      },
    });
  });

  it('emits correlated JSON lines', () => {
    const lines: string[] = [];
    withLogContext(
      {
        clarificationId: 'clarification_12345678',
        clientId: 'pixel-overlay',
        itemId: 'task_item_12345678',
        observationId: 'observation_12345678',
        operationId: 'operation_12345678',
        realtimeSessionId: 'realtime_12345678',
        requestId: 'turn-12345678',
        route: 'voice.turn',
        selectionId: 'selection_12345678',
        taskId: 'task_12345678',
      },
      () => logEvent('info', 'tool.selected', { toolName: 'inspect_cart' }, lines.push.bind(lines)),
    );

    expect(JSON.parse(lines[0]!)).toMatchObject({
      clientId: 'pixel-overlay',
      event: 'tool.selected',
      clarificationId: 'clarification_12345678',
      itemId: 'task_item_12345678',
      level: 'info',
      observationId: 'observation_12345678',
      operationId: 'operation_12345678',
      realtimeSessionId: 'realtime_12345678',
      requestId: 'turn-12345678',
      route: 'voice.turn',
      selectionId: 'selection_12345678',
      taskId: 'task_12345678',
      toolName: 'inspect_cart',
    });
  });

  it('logs function completion and failures', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(traceFunction('example.ok', {}, async () => ({ ok: true }), (result) => result))
      .resolves.toEqual({ ok: true });
    await expect(traceFunction('example.fail', {}, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(info.mock.calls.some(([line]) => String(line).includes('"functionName":"example.ok"')))
      .toBe(true);
    expect(error.mock.calls.some(([line]) => String(line).includes('"event":"function.error"')))
      .toBe(true);

    info.mockRestore();
    error.mockRestore();
  });
});
