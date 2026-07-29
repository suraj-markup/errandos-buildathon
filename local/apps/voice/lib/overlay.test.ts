import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const CAPABILITY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CAPABILITY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PACKAGE_A = 'package:/data/app/install-a/ai.errandos.overlay/base.apk\n';
const PACKAGE_B = 'package:/data/app/install-b/ai.errandos.overlay/base.apk\n';

function complete(
  callback: (error: Error | null, stdout: string, stderr: string) => void,
  stdout = '',
  stderr = '',
): void {
  callback(null, stdout, stderr);
}

function mockAvailableOverlay(): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      arguments_: string[],
      _options: unknown,
      callback: (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      if (arguments_.includes('pm')) {
        complete(callback, PACKAGE_A);
        return;
      }
      if (arguments_.includes('run-as')) {
        complete(callback, `${CAPABILITY_A}\n`);
        return;
      }
      complete(callback, 'Broadcast completed: result=0\n');
    },
  );
}

describe('overlay status ingress transport', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  it('retrieves the private capability and includes it in every STATUS broadcast', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        arguments_: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        if (arguments_.includes('pm')) {
          complete(callback, PACKAGE_A);
          return;
        }
        if (arguments_.includes('run-as')) {
          complete(callback, `${CAPABILITY_A}\n`);
          return;
        }
        complete(callback, 'Broadcast completed: result=0\n');
      },
    );
    const { publishOverlayStatus, setOverlayCaptureSuppressed } = await import(
      './overlay'
    );

    await expect(
      publishOverlayStatus('Searching safely', 'searching'),
    ).resolves.toBe(true);
    await expect(setOverlayCaptureSuppressed(true)).resolves.toBe(true);

    const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const capabilityReads = calls.filter((arguments_) =>
      arguments_.includes('run-as'));
    const broadcasts = calls.filter((arguments_) =>
      arguments_.includes('broadcast'));
    expect(capabilityReads).toEqual([[
      '-s',
      expect.any(String),
      'shell',
      'run-as',
      'ai.errandos.overlay',
      'cat',
      'files/status-ingress-capability',
    ]]);
    expect(broadcasts).toHaveLength(2);
    for (const arguments_ of broadcasts) {
      const capabilityIndex = arguments_.indexOf('ingressCapability');
      expect(arguments_.slice(capabilityIndex - 1, capabilityIndex + 2)).toEqual([
        '--es',
        'ingressCapability',
        CAPABILITY_A,
      ]);
    }
  });

  it('fails closed without a valid 256-bit capability and never broadcasts unauthenticated', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        arguments_: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        if (arguments_.includes('pm')) {
          complete(callback, PACKAGE_A);
          return;
        }
        complete(callback, 'not-a-capability\n');
      },
    );
    const { publishBroadOverlayAttention } = await import('./overlay');

    await expect(
      publishBroadOverlayAttention('cart'),
    ).resolves.toBe(false);
    const broadcasts = execFileMock.mock.calls.filter((call) =>
      (call[1] as string[]).includes('broadcast'));
    expect(broadcasts).toHaveLength(0);
  });

  it('refreshes on rejection and when the installed package identity changes', async () => {
    let currentPackage = PACKAGE_A;
    let capabilityReadCount = 0;
    let broadcastCount = 0;
    execFileMock.mockImplementation(
      (
        _file: string,
        arguments_: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        if (arguments_.includes('pm')) {
          complete(callback, currentPackage);
          return;
        }
        if (arguments_.includes('run-as')) {
          capabilityReadCount += 1;
          complete(
            callback,
            `${capabilityReadCount === 1 ? CAPABILITY_A : CAPABILITY_B}\n`,
          );
          return;
        }
        broadcastCount += 1;
        complete(
          callback,
          broadcastCount === 1
            ? 'Broadcast rejected: ingress denied\n'
            : 'Broadcast completed: result=0\n',
        );
      },
    );
    const { clearOverlaySpatialAttention, publishOverlayStatus } = await import(
      './overlay'
    );

    await expect(clearOverlaySpatialAttention()).resolves.toBe(true);
    currentPackage = PACKAGE_B;
    await expect(
      publishOverlayStatus('Ready', 'ready'),
    ).resolves.toBe(true);

    const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const broadcasts = calls.filter((arguments_) =>
      arguments_.includes('broadcast'));
    expect(capabilityReadCount).toBe(3);
    expect(
      broadcasts.map((arguments_) =>
        arguments_[arguments_.indexOf('ingressCapability') + 1]),
    ).toEqual([CAPABILITY_A, CAPABILITY_B, CAPABILITY_B]);
  });

  it('preserves no-op behavior when the target device is unavailable', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _arguments: string[],
        _options: unknown,
        callback: (error: Error) => void,
      ) => {
        callback(new Error('device offline'));
      },
    );
    const { publishOverlayStatus } = await import('./overlay');

    await expect(
      publishOverlayStatus('Offline', 'error'),
    ).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('base64-encodes private spatial attention without sending raw payload', async () => {
    mockAvailableOverlay();
    const { publishPrivateOverlayAttention } = await import('./overlay');
    const payload = '{"subject":"private-selector-and-coordinates"}';

    await expect(
      publishPrivateOverlayAttention(payload),
    ).resolves.toBe(true);

    const broadcast = execFileMock.mock.calls
      .map((call) => call[1] as string[])
      .find((arguments_) => arguments_.includes('broadcast'));
    expect(broadcast).toBeDefined();
    expect(broadcast).toContain('spatialAttentionBase64');
    expect(broadcast).toContain(
      Buffer.from(payload, 'utf8').toString('base64'),
    );
    expect(broadcast).not.toContain(payload);
  });

  it('rejects empty and oversized private attention before invoking adb', async () => {
    const { publishPrivateOverlayAttention } = await import('./overlay');

    await expect(publishPrivateOverlayAttention('')).resolves.toBe(false);
    await expect(
      publishPrivateOverlayAttention('x'.repeat(12_001)),
    ).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('allows only bounded broad-attention subjects', async () => {
    mockAvailableOverlay();
    const { publishBroadOverlayAttention } = await import('./overlay');

    await expect(
      publishBroadOverlayAttention('screen coordinates'),
    ).resolves.toBe(false);
    await expect(publishBroadOverlayAttention('options')).resolves.toBe(true);

    const broadcasts = execFileMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((arguments_) => arguments_.includes('broadcast'));
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual(expect.arrayContaining([
      '--es',
      'broadAttentionSubject',
      'options',
    ]));
  });

  it('preserves authenticated clear and capture-suppression extras', async () => {
    mockAvailableOverlay();
    const { clearOverlaySpatialAttention, setOverlayCaptureSuppressed } =
      await import('./overlay');

    await expect(clearOverlaySpatialAttention()).resolves.toBe(true);
    await expect(setOverlayCaptureSuppressed(false)).resolves.toBe(true);

    const broadcasts = execFileMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((arguments_) => arguments_.includes('broadcast'));
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]).toEqual(expect.arrayContaining([
      '--es',
      'clearSpatialAttention',
      'true',
    ]));
    expect(broadcasts[1]).toEqual(expect.arrayContaining([
      '--ez',
      'captureSuppressed',
      'false',
    ]));
    for (const broadcast of broadcasts) {
      expect(broadcast).toEqual(expect.arrayContaining([
        '--es',
        'ingressCapability',
        CAPABILITY_A,
      ]));
    }
  });
});
