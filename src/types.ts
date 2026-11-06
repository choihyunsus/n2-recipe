// Public recipe and tool contracts keep lifecycle enforcement independent of model providers.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const PHASES = ['boot', 'work_start', 'work_end', 'end'] as const;
export type Phase = (typeof PHASES)[number];
export type OnFail = { action: 'abort' | 'skip' } | { action: 'goto'; target: string };
export interface RecipeStep {
  name: string;
  tool: string;
  args: JsonValue;
  required: boolean;
  inject: string;
  onFail: OnFail;
  condition: string | null;
  unlock: string[];
}
export interface Recipe {
  name: string;
  phase: Phase;
  version: string;
  enforce: boolean;
  steps: RecipeStep[];
  sourceHash: string;
}
export interface PhaseContext {
  prompt: string;
  systemAdditions: string[];
  userAdditions: string[];
  variables: Record<string, string>;
  lastFailure: string | null;
  lastStepFailed: boolean;
  modifiedFiles: string[];
}

export interface ToolResult {
  success: boolean;
  output: string;
  data?: JsonValue;
  modifiedFiles?: string[];
}

export interface ToolContext {
  readonly project: string;
  readonly agent: string;
  readonly runId: string;
  readonly callId: string;
  readonly phase: Phase | 'work';
  readonly signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  version: string;
  readOnly?: boolean;
  idempotent?: boolean;
  execute(args: JsonValue, context: ToolContext): ToolResult | Promise<ToolResult>;
}
