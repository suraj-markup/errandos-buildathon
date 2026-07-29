function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Execution fingerprints require finite numbers.');
      }
      return Object.is(value, -0) ? '0' : String(value);
    case 'undefined':
      return '"[undefined]"';
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error(`Unsupported execution fingerprint value: ${typeof value}.`);
    case 'object': {
      if (seen.has(value)) {
        throw new Error('Execution fingerprints cannot contain cycles.');
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`)
          .join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
  }
  throw new Error('Unsupported execution fingerprint value.');
}

export function canonicalExecutionValueV2(value: unknown): string {
  return canonicalize(value, new Set());
}

// FNV-1a is used for a compact deterministic identifier, not for security.
export function stableExecutionFingerprintV2(value: unknown): string {
  const input = canonicalExecutionValueV2(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `exec_v2_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
