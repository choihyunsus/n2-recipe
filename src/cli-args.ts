// Keep command-line parsing explicit so task text remains literal and duplicate flags are rejected.
const FLAGS: Record<string, readonly string[]> = {
  validate: ['recipes'],
  status: ['db', 'project', 'agent', 'run-id'],
  run: ['db', 'project', 'agent', 'run-id', 'session-id', 'task', 'adapter'],
};
export function parseCli(args: string[]): { command: string; values: Map<string, string> } {
  const command = args[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command) && args.length <= 1)
    return { command: 'help', values: new Map() };
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Expected validate, status or run');
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error('Expected a named --option');
    const equal = token.indexOf('='),
      name = token.slice(2, equal < 0 ? undefined : equal);
    const value = equal < 0 ? args[++index] : token.slice(equal + 1);
    if (!FLAGS[command]!.includes(name) || values.has(name) || value === undefined)
      throw new Error(`Unknown, repeated or incomplete option --${name}`);
    values.set(name, value);
  }
  return { command, values };
}
export function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || !value.trim()) throw new Error(`Required option --${name} is missing`);
  return value;
}
