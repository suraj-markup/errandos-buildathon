import { createHash } from 'node:crypto';
import { capabilityCatalogV2 } from '../../policy/v2/capability-catalog';
import type { PhoneCapabilityV2 } from '../../policy/v2/types';
import {
  canonicalGeneralMobileActionDigestV2,
  GeneralMobileObservationCancelledErrorV2,
  type AdapterObservationCaptureV2,
  type GeneralMobileActionV2,
  type GeneralMobileAdapterResultV2,
  type GeneralMobileAdapterV2,
  type GeneralMobileObservationV2,
  type SemanticElementRoleV2,
} from './contracts';

type FakeScreenIdV2 = 'dialog' | 'editor' | 'home' | 'sensitive';

type FakeElementV2 = {
  localNodeId: string;
  role: SemanticElementRoleV2;
  label: string;
  state?: 'editable' | 'enabled';
};

type InstrumentedFakeAdapterOptionsV2 = {
  adapterId?: string;
  now?: () => number;
  packageName?: string;
};

const supportedCapabilities: PhoneCapabilityV2[] = [
  'activate',
  'back',
  'observe',
  'set_text',
  'wait_for_change',
];

export class InstrumentedFakeGeneralMobileAdapterV2
implements GeneralMobileAdapterV2 {
  readonly descriptor;
  readonly #now: () => number;
  #screen: FakeScreenIdV2 = 'home';
  #screenBeforeDialog: FakeScreenIdV2 = 'home';
  #revision = 0;
  #draft = '';
  #unexpectedDialog = false;
  #noProgressRemaining = 0;
  readonly actionLog: Array<{
    actionId: string;
    capability: PhoneCapabilityV2;
    status: GeneralMobileAdapterResultV2['status'];
  }> = [];

  constructor(options: InstrumentedFakeAdapterOptionsV2 = {}) {
    const adapterId = options.adapterId ?? 'instrumented-fake';
    const packageName = options.packageName ?? 'test.instrumented.app';
    this.#now = options.now ?? Date.now;
    this.descriptor = {
      version: 2 as const,
      adapterId,
      displayName: 'Instrumented general-mobile test adapter',
      packages: [packageName],
      capabilities: supportedCapabilities.map((capability) => ({
        ...capabilityCatalogV2[capability],
      })),
    };
  }

  queueUnexpectedDialog(): void {
    this.#unexpectedDialog = true;
  }

  forceSensitiveScreen(): void {
    this.#screen = 'sensitive';
    this.#revision += 1;
  }

  setNoProgress(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid no-progress count.');
    }
    this.#noProgressRemaining = count;
  }

  state(): {
    draft: string;
    revision: number;
    screen: FakeScreenIdV2;
  } {
    return {
      draft: this.#draft,
      revision: this.#revision,
      screen: this.#screen,
    };
  }

  async observe(input: {
    clientId: string;
    isCancelled?: () => boolean;
    packageName: string;
    operationId: string;
  }): Promise<AdapterObservationCaptureV2> {
    if (input.isCancelled?.()) {
      throw new GeneralMobileObservationCancelledErrorV2();
    }
    if (!this.descriptor.packages.includes(input.packageName)) {
      throw new Error('Fake adapter observation escaped package scope.');
    }
    const elements = this.elements();
    const source = this.source(elements);
    const fingerprint = this.fingerprint(source);
    return {
      captureId: `capture:${this.#revision}:${input.operationId}`,
      packageName: input.packageName,
      capturedAt: this.#now(),
      fingerprint,
      source,
      candidates: elements.map((element) => ({ ...element })),
    };
  }

  async execute(
    action: GeneralMobileActionV2,
    context: {
      observation?: GeneralMobileObservationV2;
      isCancelled: () => boolean;
    },
  ): Promise<GeneralMobileAdapterResultV2> {
    if (context.isCancelled()) return this.record(action, {
      status: 'cancelled',
      reasonRef: 'fake:cancelled_before_action',
    });
    if (this.#unexpectedDialog && action.capability !== 'back') {
      this.#unexpectedDialog = false;
      this.#screenBeforeDialog = this.#screen;
      this.#screen = 'dialog';
      this.#revision += 1;
      return this.record(action, {
        status: 'unexpected_dialog',
        reasonRef: 'fake:unexpected_dialog',
      });
    }
    if (this.#noProgressRemaining > 0) {
      this.#noProgressRemaining -= 1;
      return this.record(action, {
        status: 'no_progress',
        reasonRef: 'fake:fingerprint_unchanged',
      });
    }
    if (['activate', 'set_text'].includes(action.capability)) {
      const currentFingerprint = this.fingerprint(this.source(this.elements()));
      if (
        !context.observation
        || context.observation.fingerprint !== currentFingerprint
        || !action.targetRef
      ) {
        return this.record(action, {
          status: 'stale_target',
          reasonRef: 'fake:stale_semantic_target',
        });
      }
      const target = context.observation.elements.find(
        (element) => element.elementRef === action.targetRef,
      );
      if (!target) {
        return this.record(action, {
          status: 'stale_target',
          reasonRef: 'fake:unknown_semantic_target',
        });
      }
      if (action.capability === 'activate') {
        if (this.#screen === 'home' && target.label === 'Open editor') {
          this.#screen = 'editor';
          this.#revision += 1;
          return this.record(action, {
            status: 'verified',
            resultRef: 'fake:navigated_to_editor',
          });
        }
        return this.record(action, {
          status: 'failed',
          reasonRef: 'fake:unsupported_activation',
        });
      }
      const text = (
        action.input
        && typeof action.input === 'object'
        && !Array.isArray(action.input)
      )
        ? (action.input as Record<string, unknown>)['text']
        : undefined;
      if (
        this.#screen !== 'editor'
        || target.role !== 'field'
        || typeof text !== 'string'
      ) {
        return this.record(action, {
          status: 'failed',
          reasonRef: 'fake:invalid_local_edit',
        });
      }
      this.#draft = text.slice(0, 500);
      this.#revision += 1;
      return this.record(action, {
        status: 'verified',
        resultRef: 'fake:local_edit_verified',
      });
    }
    if (action.capability === 'back') {
      if (this.#screen === 'dialog') {
        this.#screen = this.#screenBeforeDialog;
      } else if (this.#screen === 'editor') {
        this.#screen = 'home';
      }
      this.#revision += 1;
      return this.record(action, {
        status: 'verified',
        resultRef: 'fake:navigated_back',
      });
    }
    if (action.capability === 'wait_for_change' || action.capability === 'observe') {
      return this.record(action, {
        status: 'verified',
        resultRef: 'fake:observation_stable',
      });
    }
    return this.record(action, {
      status: 'failed',
      reasonRef: 'fake:unsupported_capability',
    });
  }

  private elements(): FakeElementV2[] {
    switch (this.#screen) {
      case 'home':
        return [
          {
            localNodeId: 'home-title',
            role: 'heading',
            label: 'Test home',
          },
          {
            localNodeId: 'open-editor',
            role: 'button',
            label: 'Open editor',
            state: 'enabled',
          },
        ];
      case 'editor':
        return [
          {
            localNodeId: 'editor-title',
            role: 'heading',
            label: 'Draft editor',
          },
          {
            localNodeId: 'draft-field',
            role: 'field',
            label: 'Draft text',
            state: 'editable',
          },
        ];
      case 'dialog':
        return [{
          localNodeId: 'dialog-title',
          role: 'dialog',
          label: 'Unexpected dialog',
        }];
      case 'sensitive':
        return [{
          localNodeId: 'otp-field',
          role: 'field',
          label: 'Enter OTP verification code',
          state: 'editable',
        }];
    }
  }

  private source(elements: FakeElementV2[]): string {
    const nodes = elements.map((element) =>
      `<node text="${element.label.replace(/"/g, '&quot;')}" class="${element.role}" />`)
      .join('');
    return `<hierarchy screen="${this.#screen}" revision="${this.#revision}">${nodes}</hierarchy>`;
  }

  private fingerprint(source: string): string {
    return createHash('sha256').update(source).digest('hex');
  }

  private record(
    action: GeneralMobileActionV2,
    result: GeneralMobileAdapterResultV2,
  ): GeneralMobileAdapterResultV2 {
    this.actionLog.push({
      actionId: action.actionId,
      capability: action.capability,
      status: result.status,
    });
    return result;
  }
}

export function createInstrumentedActionV2(
  input: Omit<GeneralMobileActionV2, 'actionDigest' | 'version'>,
): GeneralMobileActionV2 {
  const material = { version: 2 as const, ...structuredClone(input) };
  const { actionDigest: _absent, ...digestInput } = material as GeneralMobileActionV2;
  return {
    ...material,
    actionDigest: canonicalGeneralMobileActionDigestV2(digestInput),
  };
}
