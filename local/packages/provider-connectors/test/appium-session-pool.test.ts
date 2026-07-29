import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppiumSessionPool,
  type AppiumSessionAcquisition,
  type ReusableAppiumSession,
} from '../src/android/appium-session-pool.js';

class FakeSession implements ReusableAppiumSession {
  public closeCount = 0;
  public healthChecks = 0;
  public healthy = true;

  public constructor(public readonly id: number) {}

  public async currentPackage(): Promise<string> {
    this.healthChecks += 1;
    if (!this.healthy) throw new Error('socket closed');
    return 'com.grofers.customerapp';
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Appium session pool', () => {
  it('reuses one healthy session for the same device and reports acquisition timing', async () => {
    let now = 100;
    const sessions: FakeSession[] = [];
    const pool = new AppiumSessionPool({
      createSession: async (): Promise<FakeSession> => {
        now += 12;
        const session = new FakeSession(sessions.length + 1);
        sessions.push(session);
        return session;
      },
      now: (): number => now,
    });
    const acquisitions: AppiumSessionAcquisition[] = [];

    await pool.withSession('pixel-1', async (session, acquisition) => {
      acquisitions.push(acquisition);
      expect(session.id).toBe(1);
    });
    now += 5;
    await pool.withSession('pixel-1', async (session, acquisition) => {
      acquisitions.push(acquisition);
      expect(session.id).toBe(1);
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.healthChecks).toBe(1);
    expect(acquisitions).toEqual([
      {
        deviceKey: 'pixel-1',
        sessionReused: false,
        sessionRecreated: false,
        sessionCreationDurationMs: 12,
      },
      {
        deviceKey: 'pixel-1',
        sessionReused: true,
        sessionRecreated: false,
        healthCheckDurationMs: 0,
      },
    ]);
    await pool.dispose();
  });

  it('recreates a session after a failed health check', async () => {
    const sessions: FakeSession[] = [];
    const pool = new AppiumSessionPool({
      createSession: async (): Promise<FakeSession> => {
        const session = new FakeSession(sessions.length + 1);
        sessions.push(session);
        return session;
      },
    });
    await pool.withSession('pixel-1', async (session) => {
      session.healthy = false;
    });

    const acquisition = await pool.withSession('pixel-1', async (session, metadata) => {
      expect(session.id).toBe(2);
      return metadata;
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.closeCount).toBe(1);
    expect(acquisition).toEqual(expect.objectContaining({
      sessionReused: false,
      sessionRecreated: true,
      recreationReason: 'health_check_failed',
    }));
    await pool.dispose();
  });

  it('invalidates transport loss without replaying work and recreates on the next acquisition', async () => {
    const sessions: FakeSession[] = [];
    let useCount = 0;
    const pool = new AppiumSessionPool({
      createSession: async (): Promise<FakeSession> => {
        const session = new FakeSession(sessions.length + 1);
        sessions.push(session);
        return session;
      },
    });

    await expect(pool.withSession('pixel-1', async () => {
      useCount += 1;
      throw new Error('Appium source_read failed');
    })).rejects.toThrow('Appium source_read failed');
    const acquisition = await pool.withSession('pixel-1', async (_session, metadata) => metadata);

    expect(useCount).toBe(1);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.closeCount).toBe(1);
    expect(acquisition).toEqual(expect.objectContaining({
      sessionRecreated: true,
      recreationReason: 'transport_loss',
    }));
    await pool.dispose();
  });

  it('expires and closes an idle session before creating a replacement', async () => {
    vi.useFakeTimers();
    const sessions: FakeSession[] = [];
    const pool = new AppiumSessionPool({
      createSession: async (): Promise<FakeSession> => {
        const session = new FakeSession(sessions.length + 1);
        sessions.push(session);
        return session;
      },
      idleTimeoutMs: 1_000,
    });
    await pool.withSession('pixel-1', async () => undefined);

    await vi.advanceTimersByTimeAsync(1_000);
    const acquisition = await pool.withSession('pixel-1', async (_session, metadata) => metadata);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.closeCount).toBe(1);
    expect(acquisition).toEqual(expect.objectContaining({
      sessionRecreated: true,
      recreationReason: 'idle_expired',
    }));
    await pool.dispose();
  });

  it('serializes all use for one device while allowing different devices to proceed', async () => {
    const pool = new AppiumSessionPool({
      createSession: async (): Promise<FakeSession> => new FakeSession(1),
    });
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstIsStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = pool.withSession('pixel-1', async () => {
      events.push('first:start');
      firstStarted();
      await holdFirst;
      events.push('first:end');
    });
    await firstIsStarted;
    const second = pool.withSession('pixel-1', async () => {
      events.push('second:start');
    });
    const otherDevice = pool.withSession('pixel-2', async () => {
      events.push('other:start');
    });
    await otherDevice;
    expect(events).toEqual(['first:start', 'other:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'other:start', 'first:end', 'second:start']);
    await pool.dispose();
  });

  it('closes sessions explicitly and disposal rejects new work', async () => {
    const sessions: FakeSession[] = [];
    const pool = new AppiumSessionPool({
      createSession: async (): Promise<FakeSession> => {
        const session = new FakeSession(sessions.length + 1);
        sessions.push(session);
        return session;
      },
    });
    await pool.withSession('pixel-1', async () => undefined);
    await pool.close('pixel-1');
    const acquisition = await pool.withSession('pixel-1', async (_session, metadata) => metadata);

    expect(sessions[0]?.closeCount).toBe(1);
    expect(acquisition.recreationReason).toBe('explicit_close');
    await pool.dispose();
    expect(sessions[1]?.closeCount).toBe(1);
    await expect(pool.withSession('pixel-1', async () => undefined))
      .rejects.toThrow('Appium session pool is disposed');
  });
});
