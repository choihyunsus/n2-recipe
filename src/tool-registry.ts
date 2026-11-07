// Registered handlers retain explicit versions and replay semantics across durable executions.
import type { JsonValue, ToolContext, ToolDefinition, ToolResult } from './types';
import { boundedText, jsonValue } from './values';

export class ToolRegistry {
  private readonly tools = new Map<string, Readonly<ToolDefinition>>();

  constructor(definitions: ToolDefinition[]) {
    if (!Array.isArray(definitions) || definitions.length > 512)
      throw new Error('Expected at most 512 registered tools');
    for (const definition of definitions) {
      const name = boundedText(definition.name, 'tool name', 128);
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || this.tools.has(name))
        throw new Error('Invalid or duplicate tool name');
      const version = boundedText(definition.version, 'tool version', 128),
        execute = definition.execute,
        readOnly = definition.readOnly,
        idempotent = definition.idempotent;
      if (!version.trim() || typeof execute !== 'function')
        throw new Error('Tool version and handler are required');
      for (const flag of [readOnly, idempotent])
        if (flag !== undefined && typeof flag !== 'boolean')
          throw new Error('Tool flags must be booleans');
      this.tools.set(
        name,
        Object.freeze({
          ...definition,
          name,
          version,
          readOnly,
          idempotent,
          execute: execute.bind(definition),
        }),
      );
    }
  }

  get(name: string): Readonly<ToolDefinition> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool is not registered: ${name}`);
    return tool;
  }

  list(): Array<{ name: string; version: string; readOnly: boolean; idempotent: boolean }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      version: tool.version,
      readOnly: tool.readOnly ?? false,
      idempotent: tool.idempotent ?? tool.readOnly ?? false,
    }));
  }

  async invoke(name: string, args: JsonValue, context: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);
    context.signal.throwIfAborted();
    const result = checkedToolResult(
      await tool.execute(jsonValue(args), Object.freeze({ ...context })),
    );
    if (tool.readOnly && result.modifiedFiles?.length)
      throw new Error('A read-only tool reported file mutations');
    return result;
  }
}

export function checkedToolResult(value: unknown): ToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a tool result object');
  const row = value as Record<string, unknown>;
  if (typeof row.success !== 'boolean') throw new Error('Tool success must be a boolean');
  const result: ToolResult = {
    success: row.success,
    output: boundedText(row.output, 'tool output'),
  };
  if (row.data !== undefined) result.data = jsonValue(row.data, 16384);
  if (row.modifiedFiles !== undefined) {
    if (!Array.isArray(row.modifiedFiles) || row.modifiedFiles.length > 1024)
      throw new Error('Too many reported file changes');
    result.modifiedFiles = [
      ...new Set(row.modifiedFiles.map((file) => boundedText(file, 'modified file', 4096))),
    ];
  }
  jsonValue(result, 128 * 1024);
  return result;
}
