import { describe, expect, it } from 'vitest';
import {
  fakePackageName,
  testSystem,
} from './test-helpers';

describe('read-only general-mobile companion', () => {
  it('explains and points using only a fresh semantic reference', async () => {
    const { companion } = testSystem();
    const result = await companion.observe({
      adapterId: 'instrumented-fake',
      clientId: 'test-client',
      operationId: 'operation:observe-home',
      packageName: fakePackageName,
      focus: 'open editor',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.explanation).toContain('Open editor');
    expect(result.observation).toMatchObject({
      adapterId: 'instrumented-fake',
      packageName: fakePackageName,
      restricted: false,
    });
    expect(result.pointTarget).toEqual({
      elementRef: expect.stringMatching(/^element:/),
      observationId: result.observation.observationId,
    });
    expect(result.observation.elements.every((element) =>
      element.observationId === result.observation.observationId)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('localNodeId');
    expect(JSON.stringify(result)).not.toContain('<hierarchy');
  });

  it('returns only a generic fallback on OTP and authentication screens', async () => {
    const { adapter, companion } = testSystem();
    adapter.forceSensitiveScreen();

    const result = await companion.observe({
      adapterId: 'instrumented-fake',
      clientId: 'test-client',
      operationId: 'operation:observe-sensitive',
      packageName: fakePackageName,
      focus: 'verification code',
    });

    expect(result).toMatchObject({
      status: 'blocked_sensitive',
      explanation: 'This screen contains private information, so visual context was not captured.',
      observation: {
        restricted: true,
        elements: [],
      },
    });
    if (result.status !== 'blocked_sensitive') {
      throw new Error('Expected a restricted observation.');
    }
    expect(result.observation.restrictedClasses).toContain('otp');
    expect(result).not.toHaveProperty('pointTarget');
    expect(JSON.stringify(result)).not.toContain('<hierarchy');
  });
});
