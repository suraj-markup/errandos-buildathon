import { randomUUID } from 'node:crypto';
import type { PrincipalId } from '@errandos/contracts';
import { AndroidWorkerOperationError, type RapidoAndroidWorkerPort } from '../android/worker-client.js';

export class AndroidRapidoAuthCoordinator {
  public constructor(private readonly worker: RapidoAndroidWorkerPort) {}

  public async status(
    _owner: PrincipalId,
    accountKey: string,
  ): Promise<{ status: 'active' | 'login_required' | 'challenge_required' }> {
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_auth_status',
      accountKey,
    });
    if (response.operation !== 'rapido_auth_status' || response.status === 'error') {
      if (response.status === 'error' && response.stage === 'device_verification_failed') {
        throw new AndroidWorkerOperationError(response.stage);
      }
      return { status: 'challenge_required' };
    }
    return { status: response.status };
  }

  public async begin(
    _owner: PrincipalId,
    accountKey: string,
    phone: string,
  ): Promise<{ sessionId: string; status: 'otp_sent' | 'active' }> {
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_begin_login',
      accountKey,
      phone,
    });
    if (response.operation !== 'rapido_begin_login' || response.status === 'error') {
      if (response.status === 'error') throw new AndroidWorkerOperationError(response.stage);
      throw new Error('Android Rapido login failed');
    }
    return { sessionId: `android_rapido_${randomUUID()}`, status: response.status };
  }

  public async submitOtp(
    _owner: PrincipalId,
    accountKey: string,
    otp: string,
  ): Promise<{ sessionId: string; status: 'active' | 'challenge_required' }> {
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_submit_otp',
      accountKey,
      otp,
    });
    if (response.operation !== 'rapido_submit_otp' || response.status === 'error') {
      if (response.status === 'error') throw new AndroidWorkerOperationError(response.stage);
      throw new Error('Android Rapido OTP failed');
    }
    return { sessionId: `android_rapido_${randomUUID()}`, status: response.status };
  }

  public async resendOtp(
    _principalId: PrincipalId,
    accountKey: string,
  ): Promise<{ sessionId: string; status: 'otp_sent' | 'active' }> {
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_resend_otp',
      accountKey,
    });
    if (response.operation !== 'rapido_resend_otp' || response.status === 'error') {
      if (response.status === 'error') throw new AndroidWorkerOperationError(response.stage);
      throw new Error('Android Rapido OTP resend failed');
    }
    return { sessionId: `android_rapido_${randomUUID()}`, status: response.status };
  }

  public async closeAll(): Promise<void> {}

  public toJSON(): Record<string, never> { return {}; }
}
