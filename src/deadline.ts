// A referenced deadline also settles callbacks that ignore cooperative cancellation.
export class InterruptedExecution extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterruptedExecution';
  }
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  milliseconds: number,
  parent?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3600000)
    throw new Error('Execution deadline must be between 1 millisecond and 1 hour');
  if (parent?.aborted) throw new InterruptedExecution('Execution was cancelled before it started');
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: NodeJS.Timeout | undefined;
  let abort = (): void => {};
  try {
    const interrupted = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new InterruptedExecution(
            controller.signal.aborted ? 'Execution deadline exceeded' : 'Execution was cancelled',
          ),
        );
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), milliseconds);
      if (signal.aborted) abort();
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted)
          throw new InterruptedExecution('Execution was cancelled before the callback started');
        return operation(signal);
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
