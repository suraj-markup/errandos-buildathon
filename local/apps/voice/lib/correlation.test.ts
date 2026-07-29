import { describe, expect, it } from 'vitest';
import {
  correlatedResult,
  correlationFields,
  createCorrelationContext,
  extendCorrelationContext,
} from './correlation';

const allIds = {
  clarificationId: 'clarification_12345678',
  clientId: 'pixel-overlay',
  itemId: 'task_item_12345678',
  observationId: 'observation_12345678',
  operationId: 'operation_12345678',
  realtimeSessionId: 'realtime_12345678',
  requestId: 'request-12345678',
  selectionId: 'selection_12345678',
  taskId: 'task_12345678',
};

describe('correlation contract', () => {
  it('validates and carries every end-to-end identifier', () => {
    const context = createCorrelationContext(allIds);

    expect(context).toEqual({ version: 1, ...allIds });
    expect(correlationFields(context)).toEqual(allIds);
    expect(correlatedResult({ ok: true }, context)).toEqual({
      ok: true,
      correlation: { version: 1, ...allIds },
    });
  });

  it('extends context without losing upstream identifiers', () => {
    const initial = createCorrelationContext({
      clientId: allIds.clientId,
      requestId: allIds.requestId,
      taskId: allIds.taskId,
    });
    const operation = extendCorrelationContext(initial, {
      itemId: allIds.itemId,
      operationId: allIds.operationId,
    });

    expect(operation).toMatchObject({
      clientId: allIds.clientId,
      itemId: allIds.itemId,
      operationId: allIds.operationId,
      requestId: allIds.requestId,
      taskId: allIds.taskId,
    });
  });

  it('rejects prose and private payloads in identifier fields', () => {
    expect(() => createCorrelationContext({
      clientId: 'pixel-overlay',
      requestId: 'add milk and send it to my home address',
    })).toThrow(/requestId/);
    expect(() => createCorrelationContext({
      clientId: 'pixel overlay with transcript',
      requestId: allIds.requestId,
    })).toThrow(/clientId/);
    expect(() => createCorrelationContext({
      clientId: allIds.clientId,
      requestId: allIds.requestId,
      taskId: 'task_milk',
    })).toThrow(/task/);
  });

  it('temporarily accepts legacy opaque observation UUIDs', () => {
    const observationId = '12345678-1234-1234-1234-123456789abc';
    expect(createCorrelationContext({
      clientId: allIds.clientId,
      observationId,
      requestId: allIds.requestId,
    }).observationId).toBe(observationId);
  });

  it('has no schema location for raw content or private values', () => {
    const serialized = JSON.stringify(createCorrelationContext(allIds));
    expect(serialized).not.toMatch(
      /transcript|audio|imageBytes|address|payment|apiKey|secret/i,
    );
  });
});
