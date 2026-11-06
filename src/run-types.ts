// Durable workflow receipts distinguish terminal outcomes from interrupted execution.
import type { Phase, PhaseContext, ToolResult, JsonValue } from './types';
import type { RecipeSources } from './recipe-bundle';
import type { MimirDatabase } from 'n2-mimir/storage';

export type SqlConnection = MimirDatabase['reasoning']['connection'];
export type ExecutionPhase = Phase | 'work';
export interface RunRequest {
  runId: string;
  sessionId?: string;
  task: string;
  modifiedFiles?: string[];
}
export interface WorkContext {
  readonly project: string;
  readonly agent: string;
  readonly runId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly context: PhaseContext;
  callTool(name: string, args?: JsonValue): Promise<ToolResult>;
}
export interface WorkHandler {
  version: string;
  idempotent?: boolean;
  execute(context: WorkContext): ToolResult | Promise<ToolResult>;
}
export interface PhaseReceipt {
  phase: Phase;
  success: boolean;
  calls: number;
  failedRequired: string[];
  missedRequired: string[];
  output: string;
}
export interface RunProgress {
  context: PhaseContext;
  phases: PhaseReceipt[];
  work: ToolResult | null;
}
export interface RunReceipt {
  runId: string;
  sessionId: string;
  project: string;
  agent: string;
  success: boolean;
  policyHash: string;
  phases: PhaseReceipt[];
  work: ToolResult | null;
  experienceId: string;
}
export interface RunRow {
  id: string;
  session_id: string;
  request_hash: string;
  policy_hash: string;
  sources_json: string;
  progress_json: string;
  state: 'running' | 'interrupted' | 'completed';
  result_json: string | null;
  error: string | null;
}
export interface CallRow {
  call_id: string;
  phase: ExecutionPhase;
  sequence: number;
  tool: string;
  version: string;
  argument_hash: string;
  arguments_json: string;
  read_only: number;
  idempotent: number;
  state: 'pending' | 'completed';
  result_json: string | null;
  reconciliation: string | null;
}
export interface RunStart {
  request: Required<RunRequest>;
  requestHash: string;
  sources: RecipeSources;
  policyHash: string;
  progress: RunProgress;
}
export class RecoveryRequired extends Error {
  constructor(
    readonly runId: string,
    readonly callId: string,
  ) {
    super(
      `Call ${callId} may have side effects. Reconcile its result before resuming run ${runId}`,
    );
    this.name = 'RecoveryRequired';
  }
}
