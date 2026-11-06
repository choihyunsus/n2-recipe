// Bound JSON, identifiers and text at public recipe and persistence boundaries.
import type { JsonValue } from './types';
export const MAX_VALUE_BYTES = 65536;

export function boundedText(value: unknown, name: string, maximum = MAX_VALUE_BYTES): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maximum)
    throw new Error(`Invalid ${name}`);
  return value;
}

export function identifier(value: unknown, name: string, maximum = 128): string {
  const result = boundedText(value, name, maximum);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

export function jsonValue(
  value: unknown,
  maximum = MAX_VALUE_BYTES,
  maximumElements = 4096,
): JsonValue {
  let elements = 0;
  let bytes = 0;
  const checkedText = (value: unknown, name: string, limit: number): string => {
    const result = boundedText(value, name, limit);
    bytes += Buffer.byteLength(result);
    if (bytes > maximum) throw new Error('JSON exceeds its byte limit');
    return result;
  };
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++elements > maximumElements || depth > 16)
      throw new Error('JSON exceeds its element or nesting limit');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return checkedText(item, 'JSON string', maximum);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        throw new Error('JSON numbers must be finite and preserve integer precision');
      return item;
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (
      item &&
      typeof item === 'object' &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
    )
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          checkedText(key, 'JSON key', 512),
          visit(child, depth + 1),
        ]),
      );
    throw new Error('Expected a plain JSON value');
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maximum)
    throw new Error('JSON exceeds its byte limit');
  return result;
}

export function booleanValue(value: unknown, name: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function scalarText(value: unknown, name: string, maximum = MAX_VALUE_BYTES): string {
  if (typeof value === 'string') return boundedText(value, name, maximum);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return String(value);
  throw new Error(`Invalid ${name}`);
}
