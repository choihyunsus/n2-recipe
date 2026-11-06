// Adapters are operator-selected local modules that supply real host checks and work handlers.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunnerOptions } from './runner';
import type { WorkHandler } from './run-types';
import { boundedText } from './values';

export interface CliAdapter {
  tools: RunnerOptions['tools'];
  work: WorkHandler;
  recipes?: RunnerOptions['recipes'];
  expertise?: RunnerOptions['expertise'];
  deadlines?: RunnerOptions['deadlines'];
}

export async function loadAdapter(filename: string): Promise<CliAdapter> {
  const resolved = fs.realpathSync(path.resolve(boundedText(filename, 'adapter filename', 4096)));
  if (!fs.statSync(resolved).isFile() || !['.js', '.cjs', '.mjs'].includes(path.extname(resolved)))
    throw new Error('Adapter must be a local JavaScript module file');
  const loaded = await import(pathToFileURL(resolved).href);
  const adapter = loaded.default ?? loaded;
  if (
    !adapter ||
    typeof adapter !== 'object' ||
    !Array.isArray(adapter.tools) ||
    typeof adapter.work?.execute !== 'function'
  )
    throw new Error('Adapter must export tools and a versioned work handler');
  return adapter as CliAdapter;
}
