// Parse legacy key/value arguments once so substituted commas cannot become new keys.
import type { JsonValue } from './types';
import { jsonValue } from './values';

export function legacyArgs(value: unknown): JsonValue {
  if (typeof value !== 'string') return jsonValue(value);
  const source = value.trim();
  if (!source) return {};
  if (!source.includes('=')) return { _arg: source };
  const pairs: string[] = [];
  let current = '',
    depth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '$' && source[index + 1] === '{') {
      depth++;
      current += '${';
      index++;
    } else if (character === '}' && depth > 0) {
      depth--;
      current += character;
    } else if (character === ',' && depth === 0) {
      pairs.push(current);
      current = '';
    } else current += character;
  }
  pairs.push(current);
  const fields = new Map<string, JsonValue>();
  for (const pair of pairs) {
    const equal = pair.indexOf('=');
    if (equal < 0) continue;
    const key = pair.slice(0, equal).trim(),
      literal = pair.slice(equal + 1).trim();
    if (key && !fields.has(key)) fields.set(key, scalar(literal));
  }
  return jsonValue(Object.fromEntries(fields));
}

function scalar(value: string): JsonValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return value;
}
