export interface ReusableAppiumSession {
  currentPackage(): Promise<string>;
  close(): Promise<void>;
}

export type AppiumSessionRecreationReason =
  | 'explicit_close'
  | 'health_check_failed'
  | 'idle_expired'
  | 'transport_loss';

export interface AppiumSessionAcquisition {
  deviceKey: string;
  sessionReused: boolean;
  sessionRecreated: boolean;
  healthCheckDurationMs?: number;
  sessionCreationDurationMs?: number;
  recreationReason?: AppiumSessionRecreationReason;
}

export interface AppiumSessionPoolOptions<Client extends ReusableAppiumSession> {
  createSession(deviceKey: string): Promise<Client>;
  healthCheck?: (client: Client, deviceKey: string) => Promise<boolean>;
  idleTimeoutMs?: number;
  isTransportError?: (error: unknown) => boolean;
  now?: () => number;
}

interface SessionEntry<Client> {
  client: Client;
  lastUsedAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  expiryToken?: object;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Owns at most one Appium session per physical device and serializes all work
 * using that session. A failed callback is never replayed: transport errors
 * only invalidate the session so the next acquisition creates a clean one.
 */
export class AppiumSessionPool<Client extends ReusableAppiumSession> {
  private readonly createSession: AppiumSessionPoolOptions<Client>['createSession'];
  private readonly healthCheck: NonNullable<AppiumSessionPoolOptions<Client>['healthCheck']>;
  private readonly idleTimeoutMs: number;
  private readonly isTransportError: NonNullable<AppiumSessionPoolOptions<Client>['isTransportError']>;
  private readonly now: () => number;
  private readonly entries = new Map<string, SessionEntry<Client>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly recreationReasons = new Map<string, AppiumSessionRecreationReason>();
  private disposed = false;

  public constructor(options: AppiumSessionPoolOptions<Client>) {
    this.createSession = options.createSession;
    this.healthCheck = options.healthCheck ?? defaultHealthCheck;
    this.idleTimeoutMs = validIdleTimeout(options.idleTimeoutMs);
    this.isTransportError = options.isTransportError ?? defaultIsTransportError;
    this.now = options.now ?? Date.now;
  }

  public async withSession<Result>(
    deviceKey: string,
    use: (client: Client, acquisition: AppiumSessionAcquisition) => Promise<Result>,
  ): Promise<Result> {
    this.assertUsableDeviceKey(deviceKey);
    if (this.disposed) throw new Error('Appium session pool is disposed');

    return this.enqueue(deviceKey, async () => {
      const { client, acquisition } = await this.acquire(deviceKey);
      try {
        return await use(client, acquisition);
      } catch (error) {
        if (this.isTransportError(error)) {
          await this.invalidate(deviceKey, client, 'transport_loss');
        }
        throw error;
      } finally {
        const entry = this.entries.get(deviceKey);
        if (entry?.client === client) {
          entry.lastUsedAt = this.now();
          this.scheduleIdleExpiry(deviceKey, entry);
        }
      }
    });
  }

  /**
   * Closes one device session after any already accepted work for that device.
   * The pool remains usable and a later acquisition creates a fresh session.
   */
  public async close(deviceKey: string): Promise<void> {
    this.assertUsableDeviceKey(deviceKey);
    if (this.disposed) return;
    await this.enqueue(deviceKey, async () => {
      const entry = this.entries.get(deviceKey);
      if (!entry) return;
      this.removeEntry(deviceKey, entry);
      this.recreationReasons.set(deviceKey, 'explicit_close');
      await safeClose(entry.client);
    });
  }

  /**
   * Closes every device session after already accepted work finishes and
   * permanently rejects new work.
   */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const deviceKeys = new Set([...this.entries.keys(), ...this.tails.keys()]);
    await Promise.all([...deviceKeys].map((deviceKey) => this.enqueue(deviceKey, async () => {
      const entry = this.entries.get(deviceKey);
      if (!entry) return;
      this.removeEntry(deviceKey, entry);
      await safeClose(entry.client);
    })));
    this.entries.clear();
    this.recreationReasons.clear();
  }

  private async acquire(deviceKey: string): Promise<{
    client: Client;
    acquisition: AppiumSessionAcquisition;
  }> {
    let entry = this.entries.get(deviceKey);
    let recreationReason = this.recreationReasons.get(deviceKey);
    let healthCheckDurationMs: number | undefined;

    if (entry) {
      this.clearIdleExpiry(entry);
      if (this.now() - entry.lastUsedAt >= this.idleTimeoutMs) {
        this.removeEntry(deviceKey, entry);
        await safeClose(entry.client);
        recreationReason = 'idle_expired';
        this.recreationReasons.set(deviceKey, recreationReason);
        entry = undefined;
      }
    }

    if (entry) {
      const healthStartedAt = this.now();
      let healthy = false;
      try {
        healthy = await this.healthCheck(entry.client, deviceKey);
      } catch {
        healthy = false;
      }
      healthCheckDurationMs = elapsed(this.now(), healthStartedAt);

      if (healthy) {
        return {
          client: entry.client,
          acquisition: {
            deviceKey,
            sessionReused: true,
            sessionRecreated: false,
            healthCheckDurationMs,
          },
        };
      }

      this.removeEntry(deviceKey, entry);
      await safeClose(entry.client);
      recreationReason = 'health_check_failed';
      this.recreationReasons.set(deviceKey, recreationReason);
    }

    const creationStartedAt = this.now();
    const client = await this.createSession(deviceKey);
    const sessionCreationDurationMs = elapsed(this.now(), creationStartedAt);
    const sessionRecreated = recreationReason !== undefined;
    this.recreationReasons.delete(deviceKey);
    this.entries.set(deviceKey, { client, lastUsedAt: this.now() });

    return {
      client,
      acquisition: {
        deviceKey,
        sessionReused: false,
        sessionRecreated,
        sessionCreationDurationMs,
        ...(recreationReason === undefined ? {} : { recreationReason }),
        ...(healthCheckDurationMs === undefined ? {} : { healthCheckDurationMs }),
      },
    };
  }

  private async invalidate(
    deviceKey: string,
    client: Client,
    reason: AppiumSessionRecreationReason,
  ): Promise<void> {
    const entry = this.entries.get(deviceKey);
    if (entry?.client !== client) return;
    this.removeEntry(deviceKey, entry);
    this.recreationReasons.set(deviceKey, reason);
    await safeClose(entry.client);
  }

  private scheduleIdleExpiry(deviceKey: string, entry: SessionEntry<Client>): void {
    this.clearIdleExpiry(entry);
    const expiryToken = {};
    entry.expiryToken = expiryToken;
    entry.expiryTimer = setTimeout(() => {
      void this.enqueue(deviceKey, async () => {
        const current = this.entries.get(deviceKey);
        if (current !== entry || current.expiryToken !== expiryToken) return;
        if (this.now() - current.lastUsedAt < this.idleTimeoutMs) {
          this.scheduleIdleExpiry(deviceKey, current);
          return;
        }
        this.removeEntry(deviceKey, current);
        this.recreationReasons.set(deviceKey, 'idle_expired');
        await safeClose(current.client);
      });
    }, this.idleTimeoutMs);
    entry.expiryTimer.unref?.();
  }

  private clearIdleExpiry(entry: SessionEntry<Client>): void {
    if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
    delete entry.expiryTimer;
    delete entry.expiryToken;
  }

  private removeEntry(deviceKey: string, entry: SessionEntry<Client>): void {
    this.clearIdleExpiry(entry);
    if (this.entries.get(deviceKey) === entry) this.entries.delete(deviceKey);
  }

  private async enqueue<Result>(deviceKey: string, operation: () => Promise<Result>): Promise<Result> {
    const preceding = this.tails.get(deviceKey) ?? Promise.resolve();
    const result = preceding.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(deviceKey, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(deviceKey) === tail) this.tails.delete(deviceKey);
    }
  }

  private assertUsableDeviceKey(deviceKey: string): void {
    if (!deviceKey.trim()) throw new Error('Appium device key must not be empty');
  }
}

async function defaultHealthCheck<Client extends ReusableAppiumSession>(
  client: Client,
): Promise<boolean> {
  return (await client.currentPackage()).trim().length > 0;
}

function defaultIsTransportError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (/\b(?:appium|transport|socket|fetch|network|connection|econn\w*|etimedout|aborted)\b/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function safeClose(client: ReusableAppiumSession): Promise<void> {
  await client.close().catch(() => undefined);
}

function validIdleTimeout(value: number | undefined): number {
  const idleTimeoutMs = value ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`Appium session idle timeout must be an integer between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`);
  }
  return idleTimeoutMs;
}

function elapsed(finishedAt: number, startedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}
