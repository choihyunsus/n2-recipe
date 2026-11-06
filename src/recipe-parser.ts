// Compile lifecycle recipes from the published Clotho WASM AST with explicit subset validation.
import { createHash } from 'node:crypto';
import { parse_n2_wasm } from 'n2-clotho';
import { PHASES, type Phase, type Recipe, type RecipeStep, type OnFail } from './types';
import { booleanValue, boundedText, identifier, jsonValue, scalarText } from './values';
import { legacyArgs } from './legacy-args';

interface AstField {
  key: string;
  value: unknown;
}
interface AstStep {
  name: string;
  fields: AstField[];
  output: unknown;
  expects: unknown[];
}
interface AstBlock {
  type: string;
  fields: AstField[];
  steps?: AstStep[];
}

export function parseRecipe(source: string): Recipe {
  boundedText(source, 'recipe source', 65536);
  const ast = parseAst(source);
  if (
    ast.blocks.length !== 2 ||
    ast.blocks.filter((block) => block.type === 'Meta').length !== 1 ||
    ast.blocks.filter((block) => block.type === 'Recipe').length !== 1
  )
    throw new Error('A lifecycle recipe requires exactly one @meta and one @recipe block');
  const metadata = fields(ast.blocks.find((block) => block.type === 'Meta')!.fields);
  const block = ast.blocks.find((block) => block.type === 'Recipe')!;
  const settings = fields(block.fields);
  if ([...settings.keys()].some((key) => key !== 'enforce'))
    throw new Error('Only enforce is executable at recipe level');
  const phase = scalarText(metadata.get('phase'), 'recipe phase', 32);
  if (!PHASES.includes(phase as Phase)) throw new Error('Unknown lifecycle phase');
  const name = scalarText(metadata.get('name'), 'recipe name', 128);
  if (!name.trim()) throw new Error('Recipe name is required');
  const enforcement = settings.has('enforce')
    ? scalarText(settings.get('enforce'), 'enforcement', 32)
    : 'warn';
  if (!['strict', 'lenient', 'warn'].includes(enforcement))
    throw new Error('Unknown recipe enforcement');
  const raw = block.steps ?? [];
  if (raw.length > 64) throw new Error('A recipe may contain at most 64 steps');
  const steps = raw.map(compileStep);
  if (new Set(steps.map((step) => step.name)).size !== steps.length)
    throw new Error('Duplicate step name');
  for (const step of steps) {
    const failure = step.onFail;
    if (failure.action === 'goto' && !steps.some((target) => target.name === failure.target))
      throw new Error('Unknown goto target');
  }
  return {
    name,
    phase: phase as Phase,
    version: scalarText(metadata.get('version') ?? '1.0.0', 'recipe version', 128),
    enforce: enforcement === 'strict',
    steps,
    sourceHash: createHash('sha256').update(source).digest('hex'),
  };
}

function parseAst(source: string): { blocks: AstBlock[] } {
  try {
    return JSON.parse(parse_n2_wasm(source)) as { blocks: AstBlock[] };
  } catch (error) {
    throw new Error(
      `Recipe parse failed. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fields(values: AstField[]): Map<string, unknown> {
  const result = new Map<string, unknown>(),
    aliases = new Set<string>();
  for (const field of values) {
    const alias = field.key === 'args_json' ? 'args' : field.key === 'action' ? 'tool' : field.key;
    if (aliases.has(alias)) throw new Error(`Duplicate or ambiguous field ${field.key}`);
    aliases.add(alias);
    result.set(field.key, field.value);
  }
  return result;
}

function compileStep(raw: AstStep): RecipeStep {
  const name = identifier(raw.name, 'step name'),
    values = fields(raw.fields);
  const supported = new Set([
    'tool',
    'action',
    'args',
    'args_json',
    'required',
    'inject',
    'on_fail',
    'condition',
    'unlock',
  ]);
  if (raw.expects.length || raw.output !== null)
    throw new Error('Lifecycle expect/output is unsupported; use on_fail and inject');
  if ([...values.keys()].some((key) => !supported.has(key)))
    throw new Error('Unsupported lifecycle step field');
  const tool = scalarText(values.get('tool') ?? values.get('action'), 'step tool', 256);
  if (!tool.trim()) throw new Error('Step tool is required');
  let args;
  if (values.has('args_json')) {
    args = jsonValue(JSON.parse(boundedText(values.get('args_json'), 'args_json')));
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('args_json must contain an object');
  } else args = values.has('args') ? legacyArgs(values.get('args')) : {};
  const inject = scalarText(values.get('inject') ?? 'none', 'injection target', 128) || 'none';
  if (!['none', 'system_prompt', 'user_message'].includes(inject))
    identifier(inject, 'injection variable');
  const condition = values.has('condition')
    ? boundedText(values.get('condition'), 'condition', 256)
    : null;
  if (condition !== null && !/^if \$\{[A-Za-z_][A-Za-z0-9_-]*\}$/.test(condition.trim()))
    throw new Error('Unsupported condition; expected if ${variable}');
  return {
    name,
    tool,
    args,
    inject,
    condition: condition?.trim() ?? null,
    required: values.has('required') ? booleanValue(values.get('required'), 'required') : false,
    onFail: onFail(values.get('on_fail') ?? 'abort'),
    unlock: unlockMetadata(values.get('unlock')),
  };
}

function onFail(value: unknown): OnFail {
  const setting = scalarText(value, 'on_fail', 256).trim();
  if (setting === 'abort' || setting === 'skip') return { action: setting };
  if (setting.startsWith('goto '))
    return { action: 'goto', target: identifier(setting.slice(5).trim(), 'goto target') };
  throw new Error('Unsupported on_fail action');
}

function unlockMetadata(value: unknown): string[] {
  if (value === undefined) return [];
  const values =
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : value;
  if (!Array.isArray(values) || values.length > 128)
    throw new Error('Invalid legacy unlock metadata');
  return values.map((value) => boundedText(value, 'legacy unlock tool', 256));
}
