// Resolve source placeholders once and bound every accumulated prompt context.
import path from 'node:path';
import type { JsonValue, PhaseContext } from './types';
import { boundedText, identifier, jsonValue } from './values';

const MAX_INJECTION_BYTES = 8192;
const MAX_CONTEXT_BYTES = 256 * 1024;
const CODE_EXTENSIONS = new Set([
  'rs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyi',
  'go',
  'java',
]);

export function createContext(prompt: string, modifiedFiles: string[] = []): PhaseContext {
  if (!Array.isArray(modifiedFiles) || modifiedFiles.length > 1024)
    throw new Error('Too many modified files');
  const context: PhaseContext = {
    prompt: boundedText(prompt, 'prompt'),
    systemAdditions: [],
    userAdditions: [],
    variables: {},
    lastFailure: null,
    lastStepFailed: false,
    modifiedFiles: [
      ...new Set(modifiedFiles.map((file) => boundedText(file, 'modified file', 4096))),
    ],
  };
  validateContext(context);
  return context;
}

export function validateContext(context: PhaseContext): void {
  boundedText(context.prompt, 'prompt');
  if (typeof context.lastStepFailed !== 'boolean')
    throw new Error('Invalid last-step failure state');
  if (context.lastFailure !== null) boundedText(context.lastFailure, 'failure output', 262144);
  for (const additions of [context.systemAdditions, context.userAdditions]) {
    if (!Array.isArray(additions) || additions.length > 192)
      throw new Error('Too many prompt additions');
    for (const value of additions) boundedText(value, 'prompt addition', MAX_INJECTION_BYTES);
  }
  if (!Array.isArray(context.modifiedFiles) || context.modifiedFiles.length > 1024)
    throw new Error('Too many modified files');
  for (const filename of context.modifiedFiles) boundedText(filename, 'modified file', 4096);
  if (
    !context.variables ||
    typeof context.variables !== 'object' ||
    Array.isArray(context.variables) ||
    Object.keys(context.variables).length > 256
  )
    throw new Error('Invalid context variables');
  for (const [key, value] of Object.entries(context.variables)) {
    identifier(key, 'variable name', 256);
    boundedText(value, 'variable value', MAX_INJECTION_BYTES);
  }
  jsonValue(context, MAX_CONTEXT_BYTES);
}

export function resolveArguments(args: JsonValue, context: PhaseContext): JsonValue {
  validateContext(context);
  const visit = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      if (value === '${modified_files_array}') return [...context.modifiedFiles];
      if (value === '${modified_code_files_array}')
        return context.modifiedFiles.filter(supportedCode);
      return value.replace(/\$\{([^}]+)\}/g, (original, name: string) => {
        const replacement = variable(name, context);
        return replacement === undefined ? original : sanitize(replacement);
      });
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return jsonValue(visit(jsonValue(args)));
}

export function evaluateCondition(condition: string | null, context: PhaseContext): boolean {
  if (condition === null) return true;
  const name = /^if \$\{([A-Za-z_][A-Za-z0-9_-]*)\}$/.exec(condition)?.[1];
  if (!name) throw new Error('Unsupported lifecycle condition');
  if (name === 'has_code_changes') return context.modifiedFiles.some(supportedCode);
  if (name === 'last_step_failed') return context.lastStepFailed;
  const value = Object.hasOwn(context.variables, name) ? context.variables[name] : undefined;
  return value !== undefined && value !== '' && value !== 'false';
}

export function applyInjection(target: string, output: string, context: PhaseContext): void {
  if (target === 'none' || !output) return;
  const bounded = truncateUtf8(output, MAX_INJECTION_BYTES);
  const candidate = {
    ...context,
    systemAdditions: [...context.systemAdditions],
    userAdditions: [...context.userAdditions],
    variables: Object.fromEntries(Object.entries(context.variables)),
  };
  if (target === 'system_prompt') candidate.systemAdditions.push(bounded);
  else if (target === 'user_message') candidate.userAdditions.push(bounded);
  else
    Object.defineProperty(candidate.variables, identifier(target, 'injection variable'), {
      value: bounded,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  validateContext(candidate);
  context.systemAdditions = candidate.systemAdditions;
  context.userAdditions = candidate.userAdditions;
  context.variables = candidate.variables;
}

export function supportedCode(filename: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filename).slice(1).toLowerCase());
}

function variable(name: string, context: PhaseContext): string | undefined {
  if (name === 'prompt') return context.prompt;
  if (name === 'last_failure') return context.lastFailure ?? undefined;
  if (name === 'modified_files') return context.modifiedFiles.join(',');
  if (name === 'modified_code_files') return context.modifiedFiles.filter(supportedCode).join(',');
  return Object.hasOwn(context.variables, name) ? context.variables[name] : undefined;
}

function sanitize(raw: string): string {
  return Array.from(raw)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        character === '\n' || character === '\t' || (code >= 32 && !(code >= 127 && code <= 159))
      );
    })
    .slice(0, MAX_INJECTION_BYTES)
    .join('');
}

function truncateUtf8(value: string, maximum: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
