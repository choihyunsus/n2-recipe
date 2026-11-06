// Persist each external invocation before execution and reuse only matching completed receipts.
import { MimirDatabase } from 'n2-mimir/storage';
import { initializeRunSchema } from './run-schema';
import { RunLease } from './lease';
import { fingerprint } from './fingerprint';
import { boundedText, jsonValue } from './values';
import { checkedToolResult } from './tool-registry';
import type { RecipeBundle, RecipeSources } from './recipe-bundle';
import type { ToolDefinition, ToolResult, JsonValue } from './types';
import type {
  CallRow,
  ExecutionPhase,
  RunProgress,
  RunReceipt,
  RunRow,
  RunStart,
  SqlConnection,
} from './run-types';

const MAX_TRACE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_PROGRESS_BYTES = 512 * 1024;
const MAX_CALLS = 2048;
export const CALL_ORDER =
  "CASE phase WHEN 'boot' THEN 0 WHEN 'work_start' THEN 1 WHEN 'work' THEN 2 WHEN 'work_end' THEN 3 WHEN 'end' THEN 4 END,sequence";
interface ConfigurationRow {
  baseline_hash: string;
  policy_hash: string;
  sources_json: string;
  revision: number;
}

export class RunStore {
  readonly connection: SqlConnection;
  readonly scope: readonly string[];

  constructor(
    readonly memory: MimirDatabase,
    readonly project: string,
    readonly agent: string,
  ) {
    this.scope = [scopeName(project), scopeName(agent)];
    this.connection = memory.reasoning.connection;
    initializeRunSchema(this.connection);
  }

  configure(baseline: RecipeBundle): ConfigurationRow {
    return this.connection.transaction(() => {
      const existing = this.configuration();
      if (existing && existing.baseline_hash !== baseline.hash)
        throw new Error(
          'Configured N2R baseline differs. Use a separate agent scope for a different baseline',
        );
      if (!existing)
        this.connection.execute('INSERT INTO n2r_configuration VALUES(?,?,?,?,?,?,?)', [
          ...this.scope,
          baseline.hash,
          baseline.hash,
          encode(baseline.sources),
          1,
          now(),
        ]);
      return this.configuration()!;
    });
  }

  configuration(): ConfigurationRow | undefined {
    return this.connection.query<ConfigurationRow>(
      'SELECT baseline_hash,policy_hash,sources_json,revision FROM n2r_configuration WHERE project=? AND agent=?',
      this.scope,
    )[0];
  }

  updateConfiguration(bundle: RecipeBundle, expectedHash: string): number {
    return this.connection.transaction(() => {
      const current = this.configuration();
      if (!current || current.policy_hash !== expectedHash)
        throw new Error('Recipe configuration changed; reload before updating');
      this.connection.execute(
        'UPDATE n2r_configuration SET policy_hash=?,sources_json=?,revision=revision+1,updated_at=? WHERE project=? AND agent=?',
        [bundle.hash, encode(bundle.sources), now(), ...this.scope],
      );
      return current.revision + 1;
    });
  }

  acquire(runId: string): RunLease {
    return new RunLease(this.connection, this.scope, runId);
  }

  get(runId: string): RunRow | undefined {
    return this.connection.query<RunRow>(
      `SELECT id,session_id,request_hash,policy_hash,sources_json,progress_json,state,result_json,error
       FROM n2r_runs WHERE project=? AND agent=? AND id=?`,
      [...this.scope, runId],
    )[0];
  }

  begin(input: RunStart, lease: RunLease): RunRow {
    return this.connection.transaction(() => {
      lease.assert();
      const existing = this.get(input.request.runId);
      if (existing && existing.request_hash !== input.requestHash)
        throw new Error('Run ID already belongs to different input or handler versions');
      if (!existing)
        this.connection.execute(
          `INSERT INTO n2r_runs(project,agent,id,session_id,request_hash,policy_hash,request_json,sources_json,
         progress_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'running',?,?)`,
          [
            ...this.scope,
            input.request.runId,
            input.request.sessionId,
            input.requestHash,
            input.policyHash,
            encode(input.request),
            encode(input.sources),
            encode(input.progress),
            now(),
            now(),
          ],
        );
      else if (existing.state !== 'completed')
        this.connection.execute(
          "UPDATE n2r_runs SET state='running',error=NULL,updated_at=? WHERE project=? AND agent=? AND id=?",
          [now(), ...this.scope, input.request.runId],
        );
      return this.get(input.request.runId)!;
    });
  }

  saveProgress(lease: RunLease, progress: RunProgress): void {
    this.connection.transaction(() => {
      lease.assert();
      this.connection.execute(
        "UPDATE n2r_runs SET progress_json=?,updated_at=? WHERE project=? AND agent=? AND id=? AND state='running'",
        [encode(progress), now(), ...this.scope, lease.runId],
      );
    });
  }

  checkpoint(lease: RunLease): void {
    this.connection.transaction(() => {
      lease.assert();
      const row = this.get(lease.runId);
      if (!row) throw new Error('Cannot checkpoint an unknown run');
      this.connection.execute(
        `INSERT INTO n2r_checkpoints VALUES(?,?,?,?,?) ON CONFLICT(project,agent,run_id)
         DO UPDATE SET progress_json=excluded.progress_json,updated_at=excluded.updated_at`,
        [...this.scope, lease.runId, row.progress_json, now()],
      );
    });
  }

  interrupt(lease: RunLease, message: string): void {
    this.connection.transaction(() => {
      lease.assert();
      this.connection.execute(
        "UPDATE n2r_runs SET state='interrupted',error=?,updated_at=? WHERE project=? AND agent=? AND id=? AND state!='completed'",
        [message.slice(0, 4096), now(), ...this.scope, lease.runId],
      );
      this.checkpoint(lease);
    });
  }

  calls(runId: string): CallRow[] {
    return this.connection.query<CallRow>(
      `SELECT * FROM n2r_calls WHERE project=? AND agent=? AND run_id=? ORDER BY ${CALL_ORDER} LIMIT ?`,
      [...this.scope, runId, MAX_CALLS],
    );
  }

  prepareCall(
    lease: RunLease,
    phase: ExecutionPhase,
    sequence: number,
    tool: Readonly<Pick<ToolDefinition, 'name' | 'version' | 'readOnly' | 'idempotent'>>,
    args: JsonValue,
  ): { row: CallRow; fresh: boolean } {
    const argumentHash = fingerprint(args),
      argumentsJson = JSON.stringify(args),
      callId = `${phase}:${sequence}`;
    return this.connection.transaction(() => {
      lease.assert();
      const existing = this.call(lease.runId, callId);
      if (existing) {
        if (
          existing.tool !== tool.name ||
          existing.version !== tool.version ||
          existing.argument_hash !== argumentHash
        )
          throw new Error(`Replay diverged from recorded invocation ${callId}`);
        return { row: existing, fresh: false };
      }
      const count = this.connection.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM n2r_calls WHERE project=? AND agent=? AND run_id=?',
        [...this.scope, lease.runId],
      )[0]!.count;
      if (count >= MAX_CALLS) throw new Error('Run exceeded its invocation limit');
      this.reserveTrace(lease, Buffer.byteLength(argumentsJson) + MAX_RESULT_BYTES);
      this.connection.execute(
        `INSERT INTO n2r_calls(project,agent,run_id,call_id,phase,sequence,tool,version,argument_hash,
         arguments_json,read_only,idempotent,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
        [
          ...this.scope,
          lease.runId,
          callId,
          phase,
          sequence,
          tool.name,
          tool.version,
          argumentHash,
          argumentsJson,
          Number(tool.readOnly ?? false),
          Number(tool.idempotent ?? tool.readOnly ?? false),
          now(),
        ],
      );
      return { row: this.call(lease.runId, callId)!, fresh: true };
    });
  }

  completeCall(
    lease: RunLease,
    callId: string,
    result: ToolResult,
    reconciliation: string | null = null,
  ): void {
    const resultJson = JSON.stringify(checkedToolResult(result));
    this.connection.transaction(() => {
      lease.assert();
      const row = this.call(lease.runId, callId);
      if (!row || row.state !== 'pending')
        throw new Error('Only a pending invocation can be completed');
      if (row.read_only && result.modifiedFiles?.length)
        throw new Error('A read-only tool reported file mutations');
      this.connection.execute(
        "UPDATE n2r_calls SET state='completed',result_json=?,reconciliation=?,completed_at=? WHERE project=? AND agent=? AND run_id=? AND call_id=?",
        [resultJson, reconciliation, now(), ...this.scope, lease.runId, callId],
      );
      this.connection.execute(
        'UPDATE n2r_runs SET trace_bytes=trace_bytes+? WHERE project=? AND agent=? AND id=?',
        [Buffer.byteLength(resultJson) - MAX_RESULT_BYTES, ...this.scope, lease.runId],
      );
    });
  }

  finalize(lease: RunLease, progress: RunProgress): RunReceipt {
    return this.connection.transaction(() => {
      lease.assert();
      const row = this.get(lease.runId)!;
      if (row.result_json) return JSON.parse(row.result_json) as RunReceipt;
      if (this.calls(lease.runId).some((call) => call.state === 'pending'))
        throw new Error('Pending invocations must be reconciled before finalizing a workflow');
      const success =
        progress.phases.length === 4 &&
        progress.phases.every((phase) => phase.success) &&
        progress.work?.success === true;
      const experience = this.memory.insertExperience({
        project: this.project,
        agent: this.agent,
        sessionId: row.session_id,
        type: success ? 'success' : 'failure',
        category: 'n2r_workflow',
        severity: success ? 'info' : 'error',
        context: progress.context.prompt,
        action: `N2R workflow ${row.id}; policy ${row.policy_hash}`,
        outcome: JSON.stringify({ success, phases: progress.phases, work: progress.work }),
        sourceRef: `n2r:${row.id}`,
      });
      const receipt: RunReceipt = {
        runId: row.id,
        sessionId: row.session_id,
        project: this.project,
        agent: this.agent,
        success,
        policyHash: row.policy_hash,
        phases: progress.phases,
        work: progress.work,
        experienceId: experience.id,
      };
      this.connection.execute(
        "UPDATE n2r_runs SET state='completed',progress_json=?,result_json=?,error=NULL,updated_at=? WHERE project=? AND agent=? AND id=?",
        [encode(progress), encode(receipt), now(), ...this.scope, row.id],
      );
      this.checkpoint(lease);
      return receipt;
    });
  }

  private call(runId: string, callId: string): CallRow | undefined {
    return this.connection.query<CallRow>(
      'SELECT * FROM n2r_calls WHERE project=? AND agent=? AND run_id=? AND call_id=?',
      [...this.scope, runId, callId],
    )[0];
  }

  private reserveTrace(lease: RunLease, bytes: number): void {
    const updated = this.connection.execute(
      'UPDATE n2r_runs SET trace_bytes=trace_bytes+? WHERE project=? AND agent=? AND id=? AND trace_bytes+?<=?',
      [bytes, ...this.scope, lease.runId, bytes, MAX_TRACE_BYTES],
    );
    if (updated !== 1) throw new Error('Run exceeded its durable trace budget');
  }
}

export function scopeName(value: string): string {
  const name = boundedText(value, 'scope name', 512);
  if (!name.trim()) throw new Error('Project and agent must be explicit nonempty names');
  return name;
}

export function decodeSources(row: { sources_json: string }): RecipeSources {
  return JSON.parse(row.sources_json) as RecipeSources;
}
function encode(value: unknown): string {
  return JSON.stringify(jsonValue(value, MAX_PROGRESS_BYTES, 16384));
}
function now(): string {
  return new Date().toISOString();
}
