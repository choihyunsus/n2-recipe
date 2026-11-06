// Serialize host work calls and retain every reported change, including ignored return values.
import type { JsonValue, ToolResult } from './types';
import { jsonValue } from './values';

export class WorkTools {
  private sequence = 0;
  private accepting = true;
  private pendingBytes = 0;
  private failure: unknown;
  private queue = Promise.resolve();
  private readonly files = new Set<string>();

  constructor(
    private readonly invoke: (index: number, name: string, args: JsonValue) => Promise<ToolResult>,
    private readonly signal: AbortSignal,
  ) {}

  call(name: string, rawArgs: JsonValue = {}): Promise<ToolResult> {
    if (!this.accepting || this.signal.aborted)
      throw new Error('Work callback is no longer active');
    if (this.sequence >= 2047) throw new Error('Work exceeded its invocation limit');
    const args = jsonValue(rawArgs),
      bytes = Buffer.byteLength(JSON.stringify(args));
    if (this.pendingBytes + bytes > 512 * 1024)
      throw new Error('Queued work arguments exceeded their byte budget');
    const index = ++this.sequence;
    this.pendingBytes += bytes;
    const result = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const receipt = await this.invoke(index, name, args);
      for (const file of receipt.modifiedFiles ?? []) this.files.add(file);
      return receipt;
    });
    this.queue = result.then(
      () => {
        this.pendingBytes -= bytes;
      },
      (error) => {
        this.pendingBytes -= bytes;
        this.failure = error;
      },
    );
    return result;
  }

  stop(): void {
    this.accepting = false;
  }

  async finish(recordedCount: () => number): Promise<string[]> {
    this.stop();
    await this.queue;
    if (this.failure) throw this.failure;
    this.signal.throwIfAborted();
    if (recordedCount() !== this.sequence)
      throw new Error('Work replay omitted previously recorded invocations');
    return [...this.files];
  }
}
