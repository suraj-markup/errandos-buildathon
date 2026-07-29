import { createHash } from 'node:crypto';
import {
  AppiumHttpClient,
  type AndroidScreenOrientation,
  type ReadOnlyAndroidScreenPort,
} from '@errandos/provider-connectors';
import { enqueuePhoneOperation } from '../operation-queue';
import { setOverlayCaptureSuppressed } from '../overlay';
import {
  assessRestrictedScreen,
  type RestrictedScreenAssessment,
} from './privacy';
import type {
  LocalBounds,
  ObservationMetadata,
} from './observation-registry';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const DEVICE_UDID = process.env.ANDROID_DEVICE_UDID;

export type ReadOnlyCapturePort = ReadOnlyAndroidScreenPort & {
  close?: () => Promise<void>;
};

type ScreenshotCaptureFailureReason =
  | 'appium_failure'
  | 'capture_timeout'
  | 'overlay_restoration_failed'
  | 'overlay_suppression_failed'
  | 'screen_changed';

type ReadOnlyScreenshotCapture =
  | {
      image: Uint8Array;
      metadata: ObservationMetadata;
      source: string;
      status: 'captured';
    }
  | {
      reason: ScreenshotCaptureFailureReason;
      status: 'unavailable';
    };

export type SanitizedScreenshotCapture =
  | ReadOnlyScreenshotCapture
  | {
      privacy: RestrictedScreenAssessment;
      status: 'restricted';
    };

export type ScreenshotCaptureDependencies = {
  now?: () => number;
  openPort?: () => Promise<ReadOnlyCapturePort>;
  serialize?: <T>(work: () => Promise<T>) => Promise<T>;
  setOverlaySuppressed?: (suppressed: boolean) => Promise<boolean>;
};

type ScreenState = {
  fingerprint: string;
  orientation: AndroidScreenOrientation;
  packageName: string;
  source: string;
  viewport: LocalBounds;
};

function fingerprint(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function screenBounds(source: string, packageName: string): LocalBounds | undefined {
  let largest: LocalBounds | undefined;
  for (const match of source.matchAll(/<node\b[^>]*>/g)) {
    const token = match[0];
    const nodePackage = token.match(/\bpackage="([^"]*)"/)?.[1];
    const rawBounds = token.match(
      /\bbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/,
    );
    if (nodePackage !== packageName || !rawBounds) continue;
    const [left, top, right, bottom] = rawBounds.slice(1).map(Number);
    if (
      left === undefined
      || top === undefined
      || right === undefined
      || bottom === undefined
      || right <= left
      || bottom <= top
    ) {
      continue;
    }
    const bounds = {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
    if (!largest || bounds.width * bounds.height > largest.width * largest.height) {
      largest = bounds;
    }
  }
  return largest;
}

async function readScreenState(port: ReadOnlyAndroidScreenPort): Promise<ScreenState> {
  const [packageName, orientation, source, viewport] = await Promise.all([
    port.currentPackage(),
    port.orientation(),
    port.source(),
    port.windowRect(),
  ]);
  return {
    fingerprint: fingerprint(source),
    orientation,
    packageName,
    source,
    viewport,
  };
}

function unchanged(before: ScreenState, after: ScreenState): boolean {
  return before.fingerprint === after.fingerprint
    && before.orientation === after.orientation
    && before.packageName === after.packageName
    && JSON.stringify(before.viewport) === JSON.stringify(after.viewport);
}

export async function captureReadOnlyScreenshot(
  dependencies: ScreenshotCaptureDependencies = {},
): Promise<ReadOnlyScreenshotCapture> {
  const serialize = dependencies.serialize ?? enqueuePhoneOperation;
  const setOverlaySuppressed =
    dependencies.setOverlaySuppressed ?? setOverlayCaptureSuppressed;
  const openPort = dependencies.openPort
    ?? (() => AppiumHttpClient.open({
      activateApp: false,
      endpoint: APPIUM_URL,
      ...(DEVICE_UDID ? { udid: DEVICE_UDID } : {}),
    }));
  const now = dependencies.now ?? Date.now;

  return serialize(async () => {
    let port: ReadOnlyCapturePort | undefined;
    let suppressionActive = false;
    let result: ReadOnlyScreenshotCapture = {
      reason: 'appium_failure',
      status: 'unavailable',
    };
    try {
      suppressionActive = await setOverlaySuppressed(true);
      if (!suppressionActive) {
        return {
          reason: 'overlay_suppression_failed',
          status: 'unavailable',
        };
      }
      port = await openPort();
      const before = await readScreenState(port);
      const image = await port.screenshot();
      const after = await readScreenState(port);
      if (!unchanged(before, after)) {
        result = {
          reason: 'screen_changed',
          status: 'unavailable',
        };
      } else {
        result = {
          image: new Uint8Array(image),
          metadata: {
            capturedAt: now(),
            contentRect: screenBounds(before.source, before.packageName)
              ?? { ...before.viewport },
            fingerprint: before.fingerprint,
            orientation: before.orientation,
            packageName: before.packageName,
            viewport: { ...before.viewport },
          },
          source: before.source,
          status: 'captured',
        };
      }
    } catch {
      result = {
        reason: 'appium_failure',
        status: 'unavailable',
      };
    } finally {
      try {
        await port?.close?.();
      } catch {
        // Session cleanup cannot make a successful read unsafe.
      }
      if (suppressionActive) {
        const restored = await setOverlaySuppressed(false);
        if (!restored) {
          result = {
            reason: 'overlay_restoration_failed',
            status: 'unavailable',
          };
        }
      }
    }
    return result;
  });
}

export async function captureSanitizedScreenshot(
  dependencies: ScreenshotCaptureDependencies = {},
): Promise<SanitizedScreenshotCapture> {
  const capture = await captureReadOnlyScreenshot(dependencies);
  if (capture.status !== 'captured') return capture;
  const privacy = assessRestrictedScreen({
    packageName: capture.metadata.packageName,
    source: capture.source,
  });
  if (privacy.restricted) {
    capture.image.fill(0);
    return {
      privacy,
      status: 'restricted',
    };
  }
  return capture;
}
