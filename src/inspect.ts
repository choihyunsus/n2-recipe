// Read persisted execution evidence without initializing or migrating the database.
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RunRow, CallRow } from './run-types';
import { boundedText } from './values';
import { scopeName, CALL_ORDER } from './run-store';

export function inspectRun(options: {
  dbPath: string;
  project: string;
  agent: string;
  runId: string;
}): { run: RunRow; calls: CallRow[] } | undefined {
  const filename = boundedText(options.dbPath, 'database path', 4096),
    project = scopeName(options.project),
    agent = scopeName(options.agent);
  const id = boundedText(options.runId, 'run ID', 128);
  if (!filename.trim() || !id.trim()) throw new Error('Database path and run ID are required');
  const connection = new Database(path.resolve(filename), {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    const version = connection
      .prepare("SELECT value FROM meta WHERE key='n2r_schema_version'")
      .get() as { value: string } | undefined;
    if (version?.value !== '1') throw new Error('An initialized N2R schema version 1 is required');
    const run = connection
      .prepare(
        `SELECT id,session_id,request_hash,policy_hash,sources_json,progress_json,state,result_json,error
      FROM n2r_runs WHERE project=? AND agent=? AND id=?`,
      )
      .get(project, agent, id) as RunRow | undefined;
    if (!run) return undefined;
    const calls = connection
      .prepare(
        `SELECT * FROM n2r_calls WHERE project=? AND agent=? AND run_id=? ORDER BY ${CALL_ORDER} LIMIT 2048`,
      )
      .all(project, agent, id) as CallRow[];
    return { run, calls };
  } finally {
    connection.close();
  }
}
