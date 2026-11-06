// Normal execution always passes through boot, preparation, work, verification and checkpointing.
import path from 'node:path';
import { MimirDatabase } from 'n2-mimir/storage';
import {
  bundledRecipes,
  compileBundle,
  validateRecipeUpdate,
  type RecipeBundle,
  type RecipeSources,
} from './recipe-bundle';
import { RunStore, decodeSources } from './run-store';
import { Execution, type Deadlines } from './execution';
import { ToolRegistry, checkedToolResult } from './tool-registry';
import { createContext, validateContext } from './context';
import { executePhase } from './phase-executor';
import { withDeadline } from './deadline';
import { fingerprint } from './fingerprint';
import { boundedText } from './values';
import { expertiseTool, type ExpertiseOption } from './expertise';
import type { RunLease } from './lease';
import type { Phase, ToolDefinition, ToolResult } from './types';
import type {
  RunProgress,
  RunReceipt,
  RunRequest,
  RunRow,
  WorkHandler,
  CallRow,
} from './run-types';

export interface RunnerOptions {
  dbPath: string;
  project: string;
  agent: string;
  tools: ToolDefinition[];
  recipes?: RecipeSources;
  deadlines?: Partial<Deadlines>;
  expertise?: ExpertiseOption;
}

const MAX_IDENTIFIER_BYTES = 128;

export class RecipeRunner {
  private readonly memory: MimirDatabase;
  private readonly store: RunStore;
  private readonly baseline: RecipeBundle;
  private readonly tools: ToolDefinition[];
  private readonly deadlines: Deadlines;
  private readonly expertise: ToolDefinition;
  private active?: Promise<RunReceipt>;
  private abort?: AbortController;
  private closed = false;

  constructor(options: RunnerOptions) {
    this.baseline = compileBundle(options.recipes ?? bundledRecipes());
    new ToolRegistry(options.tools);
    if (
      options.tools.some((tool) =>
        ['n2r_recall', 'n2r_checkpoint', 'n2r_expertise', 'n2r_work'].includes(tool.name),
      )
    )
      throw new Error('N2R builtin tool names are reserved');
    this.tools = options.tools.map((tool) => ({ ...tool }));
    this.expertise = expertiseTool(options.expertise);
    this.deadlines = checkedDeadlines(options.deadlines);
    const filename = boundedText(options.dbPath, 'database path', 4096);
    if (!filename.trim()) throw new Error('An explicit database path is required');
    this.memory = new MimirDatabase(filename === ':memory:' ? filename : path.resolve(filename));
    try {
      this.store = new RunStore(this.memory, options.project, options.agent);
      this.store.configure(this.baseline);
    } catch (error) {
      this.memory.close();
      throw error;
    }
  }

  async run(request: RunRequest, handler: WorkHandler, signal?: AbortSignal): Promise<RunReceipt> {
    this.assertOpen();
    if (this.active) throw new Error('This runner already has an active workflow');
    const context = createContext(request.task, request.modifiedFiles);
    const input = {
      runId: runIdentifier(request.runId),
      sessionId: runIdentifier(request.sessionId ?? request.runId),
      task: context.prompt,
      modifiedFiles: context.modifiedFiles,
    };
    const work = checkedHandler(handler);
    this.abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const pending = this.execute(input, work, combined);
    this.active = pending;
    try {
      return await pending;
    } finally {
      this.active = undefined;
      this.abort = undefined;
    }
  }

  status(runId: string): { run: RunRow; calls: CallRow[] } | undefined {
    this.assertOpen();
    const run = this.store.get(runIdentifier(runId));
    return run ? { run, calls: this.store.calls(run.id) } : undefined;
  }

  recipes(): { sources: RecipeSources; hash: string; revision: number } {
    this.assertOpen();
    const config = this.store.configuration()!;
    return { sources: decodeSources(config), hash: config.policy_hash, revision: config.revision };
  }

  updateRecipe(phase: Phase, source: string, expectedHash: string): number {
    this.assertOpen();
    validateRecipeUpdate(this.baseline, phase, source);
    const current = this.recipes();
    const bundle = compileBundle({ ...current.sources, [phase]: source });
    return this.store.updateConfiguration(bundle, expectedHash);
  }

  reconcileCall(runId: string, callId: string, rawResult: ToolResult, note: string): void {
    this.assertOpen();
    const id = runIdentifier(runId);
    let result = checkedToolResult(rawResult);
    boundedText(callId, 'call ID', MAX_IDENTIFIER_BYTES);
    if (!boundedText(note, 'reconciliation evidence', 8192).trim())
      throw new Error('Reconciliation requires an evidence note');
    const lease = this.store.acquire(id);
    try {
      const row = this.store.get(id);
      if (!row || row.state === 'completed')
        throw new Error('Only unfinished runs can be reconciled');
      if (
        callId === 'work:0' &&
        this.store
          .calls(id)
          .some((call) => call.phase === 'work' && call.sequence > 0 && call.state === 'pending')
      )
        throw new Error('Reconcile pending work tool invocations before the work callback');
      if (callId === 'work:0') {
        const files = this.store
          .calls(id)
          .filter((call) => call.phase === 'work' && call.sequence > 0)
          .flatMap((call) => checkedToolResult(JSON.parse(call.result_json!)).modifiedFiles ?? []);
        result = checkedToolResult({
          ...result,
          modifiedFiles: [...new Set([...(result.modifiedFiles ?? []), ...files])],
        });
      }
      this.store.completeCall(lease, callId, result, note);
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort(new Error('Recipe runner is closing'));
    try {
      await this.active;
    } catch {
      /* The caller retains the run error and durable pending receipts. */
    }
    if (!this.memory.isClosed) this.memory.close();
  }

  private async execute(
    input: Required<RunRequest>,
    handler: WorkHandler,
    signal: AbortSignal,
  ): Promise<RunReceipt> {
    signal.throwIfAborted();
    const lease = this.store.acquire(input.runId);
    let began = false;
    try {
      const registry = new ToolRegistry([...this.tools, ...this.builtins(lease)]);
      const requestHash = executionHash(input, handler, registry);
      const configuration = this.recipes();
      const initial = {
        context: createContext(input.task, input.modifiedFiles),
        phases: [],
        work: null,
      };
      const row = this.store.begin(
        {
          request: input,
          requestHash,
          sources: configuration.sources,
          policyHash: configuration.hash,
          progress: initial,
        },
        lease,
      );
      began = true;
      if (row.result_json) return JSON.parse(row.result_json) as RunReceipt;
      return await this.resume(row, lease, registry, handler, signal);
    } catch (error) {
      if (began) {
        try {
          this.store.interrupt(lease, error instanceof Error ? error.message : String(error));
        } catch {
          /* Preserve the original execution error if ownership or storage was lost. */
        }
      }
      throw error;
    } finally {
      lease.release();
    }
  }

  private async resume(
    row: RunRow,
    lease: RunLease,
    registry: ToolRegistry,
    handler: WorkHandler,
    signal: AbortSignal,
  ): Promise<RunReceipt> {
    const bundle = compileBundle(decodeSources(row));
    for (const recipe of Object.values(bundle.recipes))
      for (const step of recipe.steps) registry.get(step.tool);
    const progress = JSON.parse(row.progress_json) as RunProgress;
    validateContext(progress.context);
    const execution = new Execution(this.store, lease, registry, this.deadlines, signal);
    await this.lifecycle(bundle, progress, execution, handler);
    execution.signal.throwIfAborted();
    return this.store.finalize(lease, progress);
  }

  private async lifecycle(
    bundle: RecipeBundle,
    progress: RunProgress,
    execution: Execution,
    handler: WorkHandler,
  ): Promise<void> {
    await this.phase('boot', bundle, progress, execution);
    if (progress.phases.every((phase) => phase.success))
      await this.phase('work_start', bundle, progress, execution);
    if (progress.phases.every((phase) => phase.success)) {
      if (!progress.work) {
        progress.work = await execution.work(handler, progress.context);
        progress.context.modifiedFiles = [
          ...new Set([...progress.context.modifiedFiles, ...(progress.work.modifiedFiles ?? [])]),
        ];
        validateContext(progress.context);
        this.store.saveProgress(execution.lease, progress);
      }
      await this.phase('work_end', bundle, progress, execution);
    }
    await this.phase('end', bundle, progress, execution);
  }

  private async phase(
    phase: Phase,
    bundle: RecipeBundle,
    progress: RunProgress,
    execution: Execution,
  ): Promise<void> {
    if (progress.phases.some((receipt) => receipt.phase === phase)) return;
    const context = structuredClone(progress.context);
    const receipt = await withDeadline(
      (signal) =>
        executePhase(bundle.recipes[phase], context, (tool, args, sequence) =>
          execution.invoke(phase, sequence, tool, args, signal),
        ),
      this.deadlines.phaseMs,
      execution.signal,
    );
    progress.context = context;
    progress.phases.push(receipt);
    this.store.saveProgress(execution.lease, progress);
  }

  private builtins(lease: RunLease): ToolDefinition[] {
    return [
      this.expertise,
      {
        name: 'n2r_recall',
        version: '1',
        readOnly: true,
        execute: () => {
          const records = this.memory.queryExperiences({
            project: this.store.project,
            agent: this.store.agent,
            type: 'success',
            limit: 4,
          });
          const output = records
            .map(
              (record) =>
                `[Historical reference ${record.id}]\n${record.context.slice(0, 1024)}\n${record.outcome.slice(0, 2048)}`,
            )
            .join('\n\n');
          return { success: true, output };
        },
      },
      {
        name: 'n2r_checkpoint',
        version: '1',
        idempotent: true,
        execute: () => {
          this.store.checkpoint(lease);
          return { success: true, output: 'Scoped workflow checkpoint saved' };
        },
      },
    ];
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Recipe runner is closed');
  }
}

function runIdentifier(value: string): string {
  if (!boundedText(value, 'run/session ID', MAX_IDENTIFIER_BYTES).trim())
    throw new Error('Run and session IDs must be nonempty');
  return value;
}

function checkedHandler(handler: WorkHandler): WorkHandler {
  if (
    !handler ||
    typeof handler.execute !== 'function' ||
    !boundedText(handler.version, 'work handler version', MAX_IDENTIFIER_BYTES).trim()
  )
    throw new Error('A versioned work callback is required');
  if (handler.idempotent !== undefined && typeof handler.idempotent !== 'boolean')
    throw new Error('Work idempotency must be a boolean');
  return { ...handler };
}

function checkedDeadlines(input: Partial<Deadlines> = {}): Deadlines {
  const result = { toolMs: 30000, phaseMs: 120000, workMs: 300000, ...input };
  for (const value of Object.values(result))
    if (!Number.isSafeInteger(value) || value < 1 || value > 3600000)
      throw new Error('Deadlines must be between 1 millisecond and 1 hour');
  return result;
}

function executionHash(
  input: Required<RunRequest>,
  handler: WorkHandler,
  registry: ToolRegistry,
): string {
  return fingerprint({
    inputHash: fingerprint(input, 512 * 1024),
    toolsHash: fingerprint(
      registry.list().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      512 * 1024,
    ),
    handler: { version: handler.version, idempotent: handler.idempotent ?? false },
  });
}
