import { describe, expect, it } from 'vitest';
import { LifecycleEventSchemaV1, LifecyclePhaseSchema } from '../src/index.js';

const event = {
  version: 1 as const,
  operationId: 'operation-1',
  eventId: 'event-1',
  sequence: 3,
  occurredAt: '2026-07-11T10:00:00.000Z',
  kind: 'proposal_prepared' as const,
  phase: 'preparation' as const,
  terminal: false,
  retryable: false,
  display: { title: 'Cart prepared', message: 'Review the order before approval.', provider: 'blinkit' as const, proposalId: 'proposal-1' },
};

describe('lifecycle contracts', () => {
  it('defines every externally visible phase', () => {
    expect(LifecyclePhaseSchema.options).toEqual(['search', 'login', 'preparation', 'approval', 'commit', 'reconciliation']);
  });

  it('round-trips a redacted lifecycle envelope', () => {
    expect(LifecycleEventSchemaV1.parse(event)).toEqual(event);
  });

  it.each(['cookie', 'otp', 'password', 'token', 'approvalCapability', 'profilePath'])('rejects secret-bearing/unknown display field %s', (field) => {
    expect(LifecycleEventSchemaV1.safeParse({ ...event, display: { ...event.display, [field]: 'secret' } }).success).toBe(false);
  });

  it('rejects unknown envelope fields and invalid sequence numbers', () => {
    expect(LifecycleEventSchemaV1.safeParse({ ...event, authorization: 'secret' }).success).toBe(false);
    expect(LifecycleEventSchemaV1.safeParse({ ...event, sequence: -1 }).success).toBe(false);
  });

  it.each([
    { ...event, phase: 'commit' }, { ...event, terminal: true }, { ...event, retryable: true },
    { ...event, kind: 'search_failed', phase: 'search', terminal: true, retryable: false },
  ])('rejects invalid kind/phase/terminal/retryable combinations', (invalid) => {
    expect(LifecycleEventSchemaV1.safeParse(invalid).success).toBe(false);
  });
});
