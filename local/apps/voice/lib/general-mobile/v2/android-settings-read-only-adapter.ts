import { createHash } from 'node:crypto';
import { AppiumHttpClient } from '@errandos/provider-connectors';
import { capabilityCatalogV2 } from '../../policy/v2/capability-catalog';
import { sanitizeSemanticText } from '../../grounding/privacy';
import {
  GeneralMobileObservationCancelledErrorV2,
  type AdapterObservationCaptureV2,
  type GeneralMobileActionV2,
  type GeneralMobileAdapterResultV2,
  type GeneralMobileAdapterV2,
  type SemanticElementRoleV2,
} from './contracts';

export const androidSettingsPackageV2 = 'com.android.settings';
export const androidSettingsReadOnlyAdapterIdV2 =
  'android-settings-read-only';

export type ForegroundSourceCaptureV2 = {
  packageName: string;
  source: string;
};

export interface ForegroundSourcePortV2 {
  capture(input: {
    expectedPackage: string;
    isCancelled: () => boolean;
  }): Promise<ForegroundSourceCaptureV2>;
}

type ClosableForegroundSourcePortV2 = {
  close(): Promise<void>;
  currentPackage(): Promise<string>;
  source(): Promise<string>;
};

type AppiumForegroundSourcePortOptionsV2 = {
  openPort?: () => Promise<ClosableForegroundSourcePortV2>;
};

export class AppiumForegroundSourcePortV2
implements ForegroundSourcePortV2 {
  readonly #openPort: () => Promise<ClosableForegroundSourcePortV2>;

  constructor(options: AppiumForegroundSourcePortOptionsV2 = {}) {
    this.#openPort = options.openPort ?? (async () =>
      AppiumHttpClient.open({
        activateApp: false,
        // The shared client still types only the two legacy commerce packages,
        // although its runtime accepts any Android package. This adapter keeps
        // the cast at the production boundary and independently enforces the
        // Settings package before and after every source read.
        appPackage: androidSettingsPackageV2 as 'com.grofers.customerapp',
        ...(process.env.APPIUM_URL
          ? { endpoint: process.env.APPIUM_URL }
          : {}),
        ...(process.env.ANDROID_DEVICE_UDID
          ? { udid: process.env.ANDROID_DEVICE_UDID }
          : {}),
      }));
  }

  async capture(input: {
    expectedPackage: string;
    isCancelled: () => boolean;
  }): Promise<ForegroundSourceCaptureV2> {
    if (input.isCancelled()) {
      throw new GeneralMobileObservationCancelledErrorV2();
    }
    const port = await this.#openPort();
    try {
      if (input.isCancelled()) {
        throw new GeneralMobileObservationCancelledErrorV2();
      }
      const packageBefore = await port.currentPackage();
      if (input.isCancelled()) {
        throw new GeneralMobileObservationCancelledErrorV2();
      }
      if (packageBefore !== input.expectedPackage) {
        throw new Error('Foreground package is outside the adapter scope.');
      }
      const source = await port.source();
      if (input.isCancelled()) {
        throw new GeneralMobileObservationCancelledErrorV2();
      }
      const packageAfter = await port.currentPackage();
      if (
        packageAfter !== packageBefore
        || packageAfter !== input.expectedPackage
      ) {
        throw new Error('Foreground package changed during observation.');
      }
      return { packageName: packageAfter, source };
    } finally {
      try {
        await port.close();
      } catch {
        // A read-only result remains safe when session cleanup fails.
      }
    }
  }
}

type AndroidSettingsReadOnlyAdapterOptionsV2 = {
  now?: () => number;
  port?: ForegroundSourcePortV2;
};

const nodeTokenPattern = /<node\b[^>]*\/?>/g;
const attributePattern = /([\w:-]+)="([^"]*)"/g;
const maximumSourceLength = 2_000_000;
const maximumCandidates = 100;

function attributesFor(token: string): Record<string, string> {
  return Object.fromEntries(
    [...token.matchAll(attributePattern)].map((match) => [
      match[1]!,
      match[2] ?? '',
    ]),
  );
}

function roleFor(attributes: Record<string, string>): SemanticElementRoleV2 {
  const className = attributes['class'] ?? '';
  if (/EditText$/.test(className)) return 'field';
  if (/Switch$/.test(className)) return 'switch';
  if (/Button$/.test(className) || attributes['clickable'] === 'true') {
    return 'button';
  }
  if (/Tab/.test(className)) return 'tab';
  if (/Image/.test(className)) return 'image';
  return 'text';
}

function stateFor(
  attributes: Record<string, string>,
): 'checked' | 'disabled' | 'editable' | 'enabled' | 'selected' | undefined {
  if (attributes['enabled'] === 'false') return 'disabled';
  if (attributes['checked'] === 'true') return 'checked';
  if (attributes['selected'] === 'true') return 'selected';
  if (
    attributes['editable'] === 'true'
    || /EditText$/.test(attributes['class'] ?? '')
  ) {
    return 'editable';
  }
  if (attributes['enabled'] === 'true') return 'enabled';
  return undefined;
}

function semanticCandidates(source: string) {
  const candidates: AdapterObservationCaptureV2['candidates'] = [];
  let nodeIndex = 0;
  for (const match of source.matchAll(nodeTokenPattern)) {
    const attributes = attributesFor(match[0]);
    const labels = [
      attributes['text'],
      attributes['content-desc'],
      attributes['hint'],
    ]
      .map((value) => value ? sanitizeSemanticText(value) : undefined)
      .filter((value): value is string => Boolean(value));
    const label = [...new Set(labels)].join(' · ').slice(0, 120);
    if (label) {
      const state = stateFor(attributes);
      candidates.push({
        localNodeId: `settings-node-${nodeIndex}`,
        role: roleFor(attributes),
        label,
        ...(state ? { state } : {}),
      });
    }
    nodeIndex += 1;
    if (candidates.length >= maximumCandidates) break;
  }
  return candidates;
}

export class AndroidSettingsReadOnlyAdapterV2
implements GeneralMobileAdapterV2 {
  readonly descriptor = {
    version: 2 as const,
    adapterId: androidSettingsReadOnlyAdapterIdV2,
    displayName: 'Android Settings read-only companion',
    packages: [androidSettingsPackageV2],
    capabilities: [{
      ...capabilityCatalogV2.observe,
    }],
  };
  readonly #now: () => number;
  readonly #port: ForegroundSourcePortV2;

  constructor(options: AndroidSettingsReadOnlyAdapterOptionsV2 = {}) {
    this.#now = options.now ?? Date.now;
    this.#port = options.port ?? new AppiumForegroundSourcePortV2();
  }

  async observe(input: {
    clientId: string;
    isCancelled?: () => boolean;
    packageName: string;
    operationId: string;
  }): Promise<AdapterObservationCaptureV2> {
    if (!this.descriptor.packages.includes(input.packageName)) {
      throw new Error('Settings observation escaped adapter package scope.');
    }
    const isCancelled = input.isCancelled ?? (() => false);
    if (isCancelled()) {
      throw new GeneralMobileObservationCancelledErrorV2();
    }
    const captured = await this.#port.capture({
      expectedPackage: input.packageName,
      isCancelled,
    });
    if (isCancelled()) {
      throw new GeneralMobileObservationCancelledErrorV2();
    }
    if (captured.packageName !== input.packageName) {
      throw new Error('Settings capture returned an out-of-scope package.');
    }
    if (
      !captured.source
      || captured.source.length > maximumSourceLength
    ) {
      throw new Error('Settings capture returned an invalid source.');
    }
    const capturedAt = this.#now();
    const fingerprint = createHash('sha256')
      .update(captured.source)
      .digest('hex');
    return {
      captureId: `capture:${fingerprint.slice(0, 24)}`,
      packageName: input.packageName,
      capturedAt,
      fingerprint,
      source: captured.source,
      candidates: semanticCandidates(captured.source),
    };
  }

  async execute(
    action: GeneralMobileActionV2,
    context: { isCancelled: () => boolean },
  ): Promise<GeneralMobileAdapterResultV2> {
    if (context.isCancelled()) {
      return {
        status: 'cancelled',
        reasonRef: 'settings:cancelled_before_read',
      };
    }
    if (
      action.packageName !== androidSettingsPackageV2
      || action.capability !== 'observe'
      || action.effect !== 'read_only'
      || action.targetRef
    ) {
      return {
        status: 'failed',
        reasonRef: 'settings:read_only_scope_violation',
      };
    }
    return {
      status: 'verified',
      resultRef: 'settings:read_only_observation_allowed',
    };
  }
}
