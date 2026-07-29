export type IdentifierKind =
  | 'clarification'
  | 'observation'
  | 'operation'
  | 'realtime'
  | 'selection'
  | 'task'
  | 'task_item';

export type LocalIdentifier<K extends IdentifierKind> = string & {
  readonly __identifierKind: K;
};

const identifierPattern =
  /^(task|task_item|operation|clarification|selection|observation|realtime)_[A-Za-z0-9-]{8,80}$/;

export class InvalidLocalIdentifierError extends Error {
  constructor(
    readonly kind: IdentifierKind,
    readonly value: unknown,
  ) {
    super(`Invalid ${kind} identifier.`);
    this.name = 'InvalidLocalIdentifierError';
  }
}

export function parseLocalIdentifier<K extends IdentifierKind>(
  kind: K,
  value: unknown,
): LocalIdentifier<K> {
  if (
    typeof value !== 'string'
    || !identifierPattern.test(value)
    || !value.startsWith(`${kind}_`)
  ) {
    throw new InvalidLocalIdentifierError(kind, value);
  }
  return value as LocalIdentifier<K>;
}

export function newLocalIdentifier<K extends IdentifierKind>(
  kind: K,
  randomUuid: () => string = () => crypto.randomUUID(),
): LocalIdentifier<K> {
  return parseLocalIdentifier(kind, `${kind}_${randomUuid()}`);
}
