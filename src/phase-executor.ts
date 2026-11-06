// Replay deterministic phase decisions from durable call receipts after interruption.
import type { JsonValue, PhaseContext, Recipe, RecipeStep, ToolResult } from './types';
import type { PhaseReceipt } from './run-types';
import { applyInjection, evaluateCondition, resolveArguments, validateContext } from './context';

export async function executePhase(
  recipe: Recipe,
  context: PhaseContext,
  invoke: (tool: string, args: JsonValue, sequence: number) => Promise<ToolResult>,
): Promise<PhaseReceipt> {
  const visited = new Set<string>();
  const receipt: PhaseReceipt = {
    phase: recipe.phase,
    success: true,
    calls: 0,
    failedRequired: [],
    missedRequired: [],
    output: '',
  };
  let cursor = 0,
    iterations = 0,
    aborted = false;
  while (cursor < recipe.steps.length && iterations < recipe.steps.length * 3) {
    iterations++;
    const step = recipe.steps[cursor]!;
    visited.add(step.name);
    if (!evaluateCondition(step.condition, context)) {
      cursor++;
      continue;
    }
    const result = await invoke(step.tool, resolveArguments(step.args, context), receipt.calls++);
    applyResult(step, result, context);
    if (result.success) {
      cursor++;
      continue;
    }
    receipt.output = result.output.slice(0, 8192);
    if (step.required && !receipt.failedRequired.includes(step.name))
      receipt.failedRequired.push(step.name);
    if (step.onFail.action === 'abort') {
      aborted = true;
      break;
    }
    if (step.onFail.action === 'skip') cursor++;
    else if (step.onFail.action === 'goto') {
      const target = step.onFail.target;
      cursor = recipe.steps.findIndex((candidate) => candidate.name === target);
    }
  }
  const exhausted = cursor < recipe.steps.length && !aborted;
  if (exhausted) receipt.output = 'Recipe exceeded its iteration limit';
  return finishPhase(recipe, receipt, visited, !aborted && !exhausted);
}

function finishPhase(
  recipe: Recipe,
  receipt: PhaseReceipt,
  visited: Set<string>,
  completed: boolean,
): PhaseReceipt {
  receipt.missedRequired = recipe.steps
    .filter((step) => step.required && !visited.has(step.name))
    .map((step) => step.name);
  receipt.success =
    completed && receipt.failedRequired.length === 0 && receipt.missedRequired.length === 0;
  return receipt;
}

function applyResult(step: RecipeStep, result: ToolResult, context: PhaseContext): void {
  context.lastStepFailed = !result.success;
  context.modifiedFiles = [...new Set([...context.modifiedFiles, ...(result.modifiedFiles ?? [])])];
  if (result.success) applyInjection(step.inject, result.output, context);
  else {
    context.lastFailure = result.output;
    Object.defineProperty(context.variables, `${step.name}_failed`, {
      value: 'true',
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  validateContext(context);
}
