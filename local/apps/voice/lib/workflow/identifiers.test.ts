import { describe, expect, it } from 'vitest';
import {
  InvalidLocalIdentifierError,
  newLocalIdentifier,
  parseLocalIdentifier,
} from './identifiers';

describe('local workflow identifiers', () => {
  it('generates prefixed opaque identifiers', () => {
    expect(newLocalIdentifier(
      'task',
      () => '12345678-1234-1234-1234-123456789abc',
    )).toBe('task_12345678-1234-1234-1234-123456789abc');
  });

  it('rejects a valid identifier used as the wrong kind', () => {
    expect(() => parseLocalIdentifier(
      'selection',
      'task_12345678-1234-1234-1234-123456789abc',
    )).toThrow(InvalidLocalIdentifierError);
  });

  it.each([
    undefined,
    '',
    'task_short',
    'task_contains spaces',
    'unknown_12345678',
  ])('rejects malformed identifiers: %s', (value) => {
    expect(() => parseLocalIdentifier('task', value))
      .toThrow(InvalidLocalIdentifierError);
  });
});
