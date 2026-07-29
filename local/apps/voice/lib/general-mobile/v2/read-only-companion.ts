import { createHash } from 'node:crypto';
import {
  assessRestrictedScreen,
  sanitizeSemanticText,
} from '../../grounding/privacy';
import type { GeneralMobileAdapterRegistryV2 } from './adapter-registry';
import {
  GeneralMobileObservationCancelledErrorV2,
  type GeneralMobileObservationV2,
  type SemanticElementReferenceV2,
} from './contracts';

export type ReadOnlyCompanionResultV2 =
  | {
    status: 'cancelled';
    explanation: string;
  }
  | {
    status: 'blocked_sensitive';
    explanation: string;
    observation: GeneralMobileObservationV2;
  }
  | {
    status: 'ready';
    explanation: string;
    observation: GeneralMobileObservationV2;
    pointTarget?: {
      elementRef: string;
      observationId: string;
    };
  };

type ReadOnlyCompanionOptionsV2 = {
  idFactory?: () => string;
  maxTtlMs?: number;
  now?: () => number;
};

export class ReadOnlyGeneralMobileCompanionV2 {
  readonly #idFactory: () => string;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  readonly #registry: GeneralMobileAdapterRegistryV2;

  constructor(
    registry: GeneralMobileAdapterRegistryV2,
    options: ReadOnlyCompanionOptionsV2 = {},
  ) {
    this.#registry = registry;
    this.#idFactory = options.idFactory
      ?? (() => `observation:${crypto.randomUUID()}`);
    this.#maxTtlMs = Math.min(Math.max(options.maxTtlMs ?? 30_000, 1), 60_000);
    this.#now = options.now ?? Date.now;
  }

  async observe(input: {
    adapterId: string;
    clientId: string;
    isCancelled?: () => boolean;
    operationId: string;
    packageName: string;
    focus?: string;
  }): Promise<ReadOnlyCompanionResultV2> {
    if (input.isCancelled?.()) {
      return {
        status: 'cancelled',
        explanation: 'Screen observation was cancelled.',
      };
    }
    const adapter = this.#registry.adapter(input.adapterId, input.packageName);
    if (!adapter) throw new Error('No adapter is registered for this package.');
    let capture;
    try {
      capture = await adapter.observe({
        clientId: input.clientId,
        isCancelled: input.isCancelled,
        packageName: input.packageName,
        operationId: input.operationId,
      });
    } catch (error) {
      if (error instanceof GeneralMobileObservationCancelledErrorV2) {
        return {
          status: 'cancelled',
          explanation: 'Screen observation was cancelled.',
        };
      }
      throw error;
    }
    if (input.isCancelled?.()) {
      return {
        status: 'cancelled',
        explanation: 'Screen observation was cancelled.',
      };
    }
    if (
      capture.packageName !== input.packageName
      || capture.capturedAt > this.#now()
    ) {
      throw new Error('Adapter returned an invalid observation capture.');
    }
    const observationId = this.#idFactory();
    const restriction = assessRestrictedScreen({
      packageName: capture.packageName,
      source: capture.source,
    });
    const expiresAt = this.#now() + this.#maxTtlMs;
    if (restriction.restricted) {
      return {
        status: 'blocked_sensitive',
        explanation: restriction.safeFallback!.message,
        observation: {
          version: 2,
          observationId,
          adapterId: input.adapterId,
          packageName: input.packageName,
          capturedAt: capture.capturedAt,
          expiresAt,
          fingerprint: capture.fingerprint,
          restricted: true,
          restrictedClasses: restriction.classes,
          elements: [],
        },
      };
    }

    const elements: SemanticElementReferenceV2[] = capture.candidates
      .slice(0, 100)
      .map((candidate) => {
        const label = candidate.label
          ? sanitizeSemanticText(candidate.label)
          : undefined;
        return {
          elementRef: `element:${createHash('sha256')
            .update(`${observationId}:${candidate.localNodeId}`)
            .digest('hex')
            .slice(0, 24)}`,
          observationId,
          role: candidate.role,
          ...(label ? { label } : {}),
          ...(candidate.state ? { state: candidate.state } : {}),
        };
      });
    const labels = elements
      .map((element) => element.label)
      .filter((label): label is string => Boolean(label));
    const focus = input.focus?.trim().toLocaleLowerCase('en-IN');
    const pointTarget = focus
      ? elements.find((element) =>
        element.label?.toLocaleLowerCase('en-IN').includes(focus))
      : undefined;
    const observation: GeneralMobileObservationV2 = {
      version: 2,
      observationId,
      adapterId: input.adapterId,
      packageName: input.packageName,
      capturedAt: capture.capturedAt,
      expiresAt,
      fingerprint: capture.fingerprint,
      restricted: false,
      restrictedClasses: [],
      elements,
    };
    return {
      status: 'ready',
      explanation: labels.length > 0
        ? `Visible options include ${labels.slice(0, 5).join(', ')}.`
        : 'The screen is visible, but it has no safe labeled controls.',
      observation,
      ...(pointTarget
        ? {
          pointTarget: {
            elementRef: pointTarget.elementRef,
            observationId,
          },
        }
        : {}),
    };
  }
}
