import { describe, expect, it } from 'vitest';
import type {
  RapidoAndroidWorkerRequestV1,
  RapidoAndroidWorkerResponseV1,
  PrincipalId,
} from '@errandos/contracts';
import {
  AndroidRapidoAuthCoordinator,
  AndroidWorkerOperationError,
  type RapidoAndroidWorkerPort,
} from '../src/index.js';

class Worker implements RapidoAndroidWorkerPort {
  public readonly requests: RapidoAndroidWorkerRequestV1[] = [];

  public constructor(
    private readonly executeRequest: (request: RapidoAndroidWorkerRequestV1) => RapidoAndroidWorkerResponseV1,
  ) {}

  public async executeRapido(request: RapidoAndroidWorkerRequestV1): Promise<RapidoAndroidWorkerResponseV1> {
    this.requests.push(request);
    return this.executeRequest(request);
  }
}

const owner = 'owner-1' as PrincipalId;

describe('Android Rapido auth coordinator', () => {
  it('relays secrets once through typed requests without retaining or returning them', async () => {
    const worker = new Worker((request) => {
      if (request.operation === 'rapido_begin_login' || request.operation === 'rapido_resend_otp') {
        return { version: 1, operation: request.operation, status: 'otp_sent' };
      }
      return { version: 1, operation: 'rapido_submit_otp', status: 'active' };
    });
    const coordinator = new AndroidRapidoAuthCoordinator(worker);

    const began = await coordinator.begin(owner, 'main', '9000000000');
    const completed = await coordinator.submitOtp(owner, 'main', '1234');
    const resent = await coordinator.resendOtp(owner, 'main');

    expect(began).toMatchObject({ status: 'otp_sent' });
    expect(completed).toMatchObject({ status: 'active' });
    expect(resent).toMatchObject({ status: 'otp_sent' });
    expect(JSON.stringify([began, completed, resent, coordinator])).not.toMatch(/9000000000|1234/);
    expect(worker.requests.map(({ operation }) => operation)).toEqual([
      'rapido_begin_login',
      'rapido_submit_otp',
      'rapido_resend_otp',
    ]);
  });

  it('returns only a sanitized challenge state for worker failures', async () => {
    const coordinator = new AndroidRapidoAuthCoordinator(new Worker(() => ({
      version: 1,
      operation: 'rapido_auth_status',
      status: 'error',
      stage: 'unexpected_provider_screen',
    })));
    await expect(coordinator.status(owner, 'main')).resolves.toEqual({ status: 'challenge_required' });
  });

  it('preserves a sanitized device-verification blocker', async () => {
    const coordinator = new AndroidRapidoAuthCoordinator(new Worker(() => ({
      version: 1,
      operation: 'rapido_auth_status',
      status: 'error',
      stage: 'device_verification_failed',
    })));
    await expect(coordinator.status(owner, 'main')).rejects.toEqual(
      expect.objectContaining<Partial<AndroidWorkerOperationError>>({
        stage: 'device_verification_failed',
      }),
    );
  });
});
