// Stable fingerprints ignore object key insertion order while retaining array and value order.
import { createHash } from 'node:crypto';
import { jsonValue } from './values';
import type { JsonValue } from './types';

export function fingerprint(value: unknown, maximum = 65536): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(jsonValue(value, maximum))))
    .digest('hex');
}

function ordered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key]!)]),
    );
  return value;
}
