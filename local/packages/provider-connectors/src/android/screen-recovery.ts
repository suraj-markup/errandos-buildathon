import { createHash } from 'node:crypto';
import type { AndroidUiPort, UiElement } from './appium-client.js';
import { detectBlinkitAndroidStage, type BlinkitAndroidStage } from '../blinkit/android-stage.js';

export type ScreenRecoveryGoal = 'authenticate' | 'storefront' | 'search' | 'address' | 'checkout' | 'payment';

export interface RecoveryElement {
  handle: string;
  label: string;
  role: 'button' | 'field' | 'text';
}

export interface RecoveryObservation {
  goal: ScreenRecoveryGoal;
  stage: BlinkitAndroidStage;
  elements: readonly RecoveryElement[];
}

export type RecoveryAction =
  | { kind: 'activate'; handle: string }
  | { kind: 'back' }
  | { kind: 'stop' };

export interface ScreenRecoveryPlanner {
  plan(observation: RecoveryObservation): Promise<RecoveryAction>;
}

export interface ScreenRecoveryPort {
  recover(goal: ScreenRecoveryGoal, expected: readonly BlinkitAndroidStage[]): Promise<BlinkitAndroidStage>;
}

export interface BoundedScreenRecoveryOptions {
  maxActions?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Execute only semantic, reversible recovery actions. This component is never
 * used for the final order action and never exposes UI XML or coordinates.
 */
export class BoundedScreenRecovery implements ScreenRecoveryPort {
  private readonly maxActions: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly ui: AndroidUiPort,
    private readonly planner: ScreenRecoveryPlanner,
    options: BoundedScreenRecoveryOptions = {},
  ) {
    this.maxActions = options.maxActions ?? 3;
    this.wait = options.wait ?? ((milliseconds): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public async recover(goal: ScreenRecoveryGoal, expected: readonly BlinkitAndroidStage[]): Promise<BlinkitAndroidStage> {
    for (let actionCount = 0; actionCount <= this.maxActions; actionCount += 1) {
      const source = await this.ui.source();
      const stage = detectBlinkitAndroidStage(source);
      if (expected.includes(stage)) return stage;
      if (actionCount === this.maxActions) return stage;

      const elements = sanitizeRecoveryElements(source);
      const action = await this.planner.plan({ goal, stage, elements });
      if (action.kind === 'stop') return stage;
      if (action.kind === 'back') {
        await this.ui.back();
      } else {
        const selected = elements.find(({ handle }) => handle === action.handle);
        if (!selected || selected.role !== 'button') return stage;
        const matches = uniqueClickableTargets([
          ...(await this.ui.findExactText(selected.label)),
          ...(await this.ui.findExactDescription(selected.label)),
          ...(await this.ui.findClickableAncestorOfExactText(selected.label)),
          ...(await this.ui.findClickableAncestorOfExactDescription(selected.label)),
        ]);
        if (matches.length !== 1) return stage;
        await this.ui.click(matches[0]!);
      }
      await this.wait(500);
    }
    return 'unknown';
  }
}

/** Known overlays are handled deterministically before an optional LLM planner. */
export class KnownScreenRecoveryPlanner implements ScreenRecoveryPlanner {
  public constructor(private readonly fallback?: ScreenRecoveryPlanner) {}

  public async plan(observation: RecoveryObservation): Promise<RecoveryAction> {
    const labels = observation.elements.map(({ label }) => label.toLowerCase());
    const exact = (label: string): RecoveryAction | undefined => {
      const target = observation.elements.find((element) => element.role === 'button' && element.label.toLowerCase() === label.toLowerCase());
      return target ? { kind: 'activate', handle: target.handle } : undefined;
    };

    if (observation.stage === 'location_permission') return exact('Select location manually') ?? { kind: 'stop' };
    if (observation.stage === 'address_picker' && ['authenticate', 'storefront', 'search'].includes(observation.goal)) {
      return exact('Home') ?? { kind: 'stop' };
    }
    if (observation.stage === 'review_prompt') return exact('Not now') ?? { kind: 'stop' };
    const overlay = labels.some((label) => /enjoying blinkit|rate (?:this|our) app|update available|new version/.test(label));
    if (overlay) {
      for (const label of ['Not now', 'Maybe later', 'No thanks', 'Close']) {
        const action = exact(label);
        if (action) return action;
      }
    }
    if (observation.stage === 'unknown' && (observation.goal === 'authenticate' || observation.goal === 'storefront')) return { kind: 'back' };
    return this.fallback?.plan(observation) ?? { kind: 'stop' };
  }
}

export function sanitizeRecoveryElements(source: string): RecoveryElement[] {
  const elements: RecoveryElement[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/<(?!\/)[A-Za-z_][\w.:-]*\b([^>]*)\/?>/g)) {
    const attributes = parseAttributes(match[1] ?? '');
    const rawLabel = attributes['text'] || attributes['content-desc'];
    if (!rawLabel) continue;
    const label = redactLabel(rawLabel).trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const clickable = attributes['clickable'] === 'true';
    const className = attributes['class'] ?? '';
    const role = clickable || isKnownSemanticAction(label) ? 'button' : className.includes('EditText') ? 'field' : 'text';
    elements.push({ handle: createHandle(elements.length, label, role), label, role });
    if (elements.length === 80) break;
  }
  return elements;
}

function uniqueClickableTargets(elements: readonly UiElement[]): UiElement[] {
  const unique = new Map<string, UiElement>();
  for (const element of elements) {
    if (element.clickable) unique.set(element.id, element);
  }
  return [...unique.values()];
}

function isKnownSemanticAction(label: string): boolean {
  return ['not now', 'maybe later', 'no thanks', 'close', 'select location manually', 'home'].includes(label.trim().toLowerCase());
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]!] = decodeXml(match[2]!);
  return attributes;
}

function decodeXml(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function redactLabel(value: string): string {
  return value
    .replace(/\b\d{4,}\b/g, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b(?:order|ref(?:erence)?)\s*[#: -]*[A-Z0-9-]{4,}\b/gi, '$1 [redacted]');
}

function createHandle(index: number, label: string, role: RecoveryElement['role']): string {
  return `element_${createHash('sha256').update(`${index}\n${role}\n${label}`).digest('hex').slice(0, 16)}`;
}
