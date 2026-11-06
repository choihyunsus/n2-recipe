// Host callbacks run outside transactions with stable call IDs and conservative recovery.
import type { JsonValue, PhaseContext, ToolResult } from './types';
import type { WorkHandler, ExecutionPhase } from './run-types';
import { RecoveryRequired } from './run-types';
import type { RunLease } from './lease';
import type { RunStore } from './run-store';
import { ToolRegistry, checkedToolResult } from './tool-registry';
import { withDeadline } from './deadline';
import { fingerprint } from './fingerprint';
import { jsonValue } from './values';
import { WorkTools } from './work-tools';

export interface Deadlines {
  toolMs: number;
  phaseMs: number;
  workMs: number;
}

export class Execution {
  readonly signal: AbortSignal;
  constructor(
    readonly store: RunStore,
    readonly lease: RunLease,
    readonly registry: ToolRegistry,
    readonly deadlines: Deadlines,
    signal?: AbortSignal,
  ) {
    this.signal = signal
      ? AbortSignal.any([signal, lease.controller.signal])
      : lease.controller.signal;
  }

  async invoke(
    phase: ExecutionPhase,
    sequence: number,
    name: string,
    rawArgs: JsonValue,
    parent = this.signal,
  ): Promise<ToolResult> {
    parent.throwIfAborted();
    const args = jsonValue(rawArgs),
      definition = this.registry.get(name);
    const { row, fresh } = this.store.prepareCall(this.lease, phase, sequence, definition, args);
    if (row.result_json) return checkedToolResult(JSON.parse(row.result_json));
    if (!fresh && !row.idempotent) throw new RecoveryRequired(this.lease.runId, row.call_id);
    const result = await withDeadline(
      (signal) =>
        this.registry.invoke(name, args, {
          project: this.store.project,
          agent: this.store.agent,
          runId: this.lease.runId,
          callId: row.call_id,
          phase,
          signal,
        }),
      this.deadlines.toolMs,
      parent,
    );
    parent.throwIfAborted();
    this.store.completeCall(this.lease, row.call_id, result);
    return result;
  }

  async work(handler: WorkHandler, context: PhaseContext): Promise<ToolResult> {
    const { row, fresh } = this.store.prepareCall(
      this.lease,
      'work',
      0,
      { name: 'n2r_work', version: handler.version, idempotent: handler.idempotent ?? false },
      { contextHash: fingerprint(context, 512 * 1024) },
    );
    if (row.result_json) return checkedToolResult(JSON.parse(row.result_json));
    if (!fresh && !row.idempotent) throw new RecoveryRequired(this.lease.runId, row.call_id);
    const result = await withDeadline(
      (signal) => this.executeWork(handler, context, signal),
      this.deadlines.workMs,
      this.signal,
    );
    this.signal.throwIfAborted();
    this.store.completeCall(this.lease, row.call_id, result);
    return result;
  }

  private async executeWork(
    handler: WorkHandler,
    context: PhaseContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const tools = new WorkTools(
      (index, name, args) => this.invoke('work', index, name, args, signal),
      signal,
    );
    try {
      const result = checkedToolResult(
        await handler.execute(
          Object.freeze({
            project: this.store.project,
            agent: this.store.agent,
            runId: this.lease.runId,
            callId: 'work:0',
            signal,
            context: structuredClone(context),
            callTool: (name: string, args?: JsonValue) => tools.call(name, args),
          }),
        ),
      );
      const modifiedFiles = await tools.finish(
        () =>
          this.store
            .calls(this.lease.runId)
            .filter((call) => call.phase === 'work' && call.sequence > 0).length,
      );
      return checkedToolResult({
        ...result,
        modifiedFiles: [...new Set([...(result.modifiedFiles ?? []), ...modifiedFiles])],
      });
    } finally {
      tools.stop();
    }
  }
}
