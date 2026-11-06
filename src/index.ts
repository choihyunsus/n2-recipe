#!/usr/bin/env node
// CLI entry point for validation, read-only inspection and explicitly configured host workflows.
import { parseCli, required } from './cli-args';
import { loadAdapter } from './cli-adapter';
import { RecipeRunner } from './runner';
import { inspectRun } from './inspect';
import { bundledRecipes, compileBundle, loadRecipeDirectory } from './recipe-bundle';

const HELP = `N2R lifecycle recipes

n2-recipe validate [--recipes DIRECTORY]
n2-recipe status --db FILE --project NAME --agent NAME --run-id ID
n2-recipe run --adapter FILE --db FILE --project NAME --agent NAME --run-id ID --task TEXT [--session-id ID]

The operator-selected adapter supplies tools, work and optional recipes, expertise and deadlines.
Use a stable run ID to inspect or resume a workflow. Pending side effects require library reconciliation.
Exit codes: 0 successful command, 1 execution/configuration error, 2 verified workflow failure.
`;

export async function main(args: string[]): Promise<number> {
  const { command, values } = parseCli(args);
  if (command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'validate') {
    const bundle = compileBundle(
      values.has('recipes') ? loadRecipeDirectory(required(values, 'recipes')) : bundledRecipes(),
    );
    print({
      valid: true,
      hash: bundle.hash,
      phases: Object.values(bundle.recipes).map((recipe) => ({
        phase: recipe.phase,
        steps: recipe.steps.length,
      })),
    });
    return 0;
  }
  const scope = {
    dbPath: required(values, 'db'),
    project: required(values, 'project'),
    agent: required(values, 'agent'),
  };
  const runId = required(values, 'run-id');
  if (command === 'status') {
    print(inspectRun({ ...scope, runId }) ?? { found: false });
    return 0;
  }
  return runHost(values, scope, runId);
}

async function runHost(
  values: Map<string, string>,
  scope: { dbPath: string; project: string; agent: string },
  runId: string,
): Promise<number> {
  const task = required(values, 'task'),
    adapter = await loadAdapter(required(values, 'adapter'));
  const runner = new RecipeRunner({
    ...scope,
    tools: adapter.tools,
    recipes: adapter.recipes,
    expertise: adapter.expertise,
    deadlines: adapter.deadlines,
  });
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error('CLI interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const result = await runner.run(
      { runId, task, sessionId: values.get('session-id') },
      adapter.work,
      controller.signal,
    );
    print(result);
    return result.success ? 0 : 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await runner.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

if (require.main === module)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n',
      );
      process.exitCode = 1;
    },
  );
