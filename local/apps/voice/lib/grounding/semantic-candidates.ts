import { randomUUID } from 'node:crypto';
import {
  sanitizeSemanticText,
} from './privacy';
import type {
  LocalBounds,
  LocalElementBinding,
} from './observation-registry';

export type SemanticCandidate = {
  elementRef: string;
  label: string;
  occurrence?: number;
  role: 'button' | 'checkbox' | 'control' | 'input' | 'radio' | 'switch';
  selected?: boolean;
};

type SemanticCandidateSet = {
  bindings: Map<string, LocalElementBinding>;
  candidates: SemanticCandidate[];
};

type SemanticCandidateOptions = {
  contentRect?: LocalBounds;
  maxCandidates?: number;
  refFactory?: (index: number) => string;
};

type SourceNode = {
  attributes: Record<string, string>;
  children: SourceNode[];
  index: number;
};

const tokenPattern = /<\/?node\b[^>]*\/?>/g;
const attributePattern = /([\w:-]+)="([^"]*)"/g;

function parseAttributes(token: string): Record<string, string> {
  return Object.fromEntries(
    [...token.matchAll(attributePattern)].map((match) => [
      match[1]!,
      match[2] ?? '',
    ]),
  );
}

function parseSource(source: string): SourceNode[] {
  const roots: SourceNode[] = [];
  const stack: SourceNode[] = [];
  let index = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('</')) {
      stack.pop();
      continue;
    }
    const node: SourceNode = {
      attributes: parseAttributes(token),
      children: [],
      index: index++,
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  return roots;
}

function booleanAttribute(node: SourceNode, name: string): boolean {
  return node.attributes[name] === 'true';
}

function boundsFor(node: SourceNode): LocalBounds | undefined {
  const value = node.attributes['bounds'];
  const match = value?.match(
    /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/,
  );
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (
    left === undefined
    || top === undefined
    || right === undefined
    || bottom === undefined
    || right <= left
    || bottom <= top
  ) {
    return undefined;
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function intersects(left: LocalBounds, right: LocalBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function isInteractive(node: SourceNode): boolean {
  const className = node.attributes['class'] ?? '';
  return booleanAttribute(node, 'clickable')
    || booleanAttribute(node, 'checkable')
    || booleanAttribute(node, 'focusable')
    || /(?:Button|CheckBox|EditText|RadioButton|Switch)$/.test(className);
}

function roleFor(node: SourceNode): SemanticCandidate['role'] {
  const className = node.attributes['class'] ?? '';
  if (/CheckBox$/.test(className)) return 'checkbox';
  if (/RadioButton$/.test(className)) return 'radio';
  if (/Switch$/.test(className)) return 'switch';
  if (/EditText$/.test(className)) return 'input';
  if (/Button$/.test(className) || booleanAttribute(node, 'clickable')) {
    return 'button';
  }
  return 'control';
}

function collectLabels(node: SourceNode, depth = 0): string[] {
  if (depth > 3) return [];
  const labels = [
    node.attributes['text'],
    node.attributes['content-desc'],
    node.attributes['hint'],
  ]
    .map((value) => value ? sanitizeSemanticText(value) : undefined)
    .filter((value): value is string => Boolean(value));
  for (const child of node.children) labels.push(...collectLabels(child, depth + 1));
  return [...new Set(labels)].slice(0, 4);
}

function boundedLabel(labels: readonly string[]): string | undefined {
  const joined = labels.join(' · ').trim();
  return joined ? joined.slice(0, 120) : undefined;
}

export function buildSanitizedSemanticCandidates(
  source: string,
  options: SemanticCandidateOptions = {},
): SemanticCandidateSet {
  const maximum = Math.min(Math.max(options.maxCandidates ?? 40, 1), 60);
  const refFactory = options.refFactory
    ?? (() => `element_${randomUUID()}`);
  const raw: Array<{
    bounds: LocalBounds;
    label: string;
    node: SourceNode;
  }> = [];
  const visit = (node: SourceNode) => {
    const bounds = boundsFor(node);
    if (
      isInteractive(node)
      && node.attributes['displayed'] !== 'false'
      && node.attributes['enabled'] !== 'false'
      && bounds
      && (!options.contentRect || intersects(bounds, options.contentRect))
    ) {
      const label = boundedLabel(collectLabels(node));
      if (label) raw.push({ bounds, label, node });
    }
    for (const child of node.children) visit(child);
  };
  for (const root of parseSource(source)) visit(root);

  const labelTotals = new Map<string, number>();
  for (const item of raw.slice(0, maximum)) {
    labelTotals.set(item.label, (labelTotals.get(item.label) ?? 0) + 1);
  }
  const labelOccurrences = new Map<string, number>();
  const candidates: SemanticCandidate[] = [];
  const bindings = new Map<string, LocalElementBinding>();
  for (const item of raw.slice(0, maximum)) {
    const elementRef = refFactory(item.node.index);
    const occurrence = (labelOccurrences.get(item.label) ?? 0) + 1;
    labelOccurrences.set(item.label, occurrence);
    candidates.push({
      elementRef,
      label: item.label,
      ...(labelTotals.get(item.label)! > 1 ? { occurrence } : {}),
      role: roleFor(item.node),
      ...(booleanAttribute(item.node, 'selected')
        || booleanAttribute(item.node, 'checked')
        ? { selected: true }
        : {}),
    });
    bindings.set(elementRef, {
      bounds: { ...item.bounds },
      localNodeId: `source-node-${item.node.index}`,
    });
  }
  return { bindings, candidates };
}
