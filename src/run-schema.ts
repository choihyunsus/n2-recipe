// Module tables are additive and reject ambiguous pre-existing N2R ownership.
import type { SqlConnection } from './run-types';

export function initializeRunSchema(connection: SqlConnection): void {
  connection.transaction(() => {
    const version = connection.query<{ value: string }>(
      "SELECT value FROM meta WHERE key='n2r_schema_version'",
    )[0];
    const existing = connection.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'n2r_*'",
    );
    if (version && version.value !== '1') throw new Error('Unsupported N2R schema version');
    if (!version && existing.length)
      throw new Error('Unversioned N2R tables require explicit migration');
    for (const table of existing) {
      const columns = connection.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [
        table.name,
      ]);
      if (!['project', 'agent'].every((name) => columns.some((column) => column.name === name)))
        throw new Error(`Unscoped ${table.name} requires explicit migration`);
    }
    for (const statement of STATEMENTS) connection.execute(statement);
    connection.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('n2r_schema_version','1')");
  });
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS n2r_configuration (
    project TEXT NOT NULL, agent TEXT NOT NULL, baseline_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL, sources_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    updated_at TEXT NOT NULL, PRIMARY KEY(project,agent))`,
  `CREATE TABLE IF NOT EXISTS n2r_runs (
    project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, request_json TEXT NOT NULL,
    sources_json TEXT NOT NULL, progress_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','interrupted','completed')),
    result_json TEXT, error TEXT, trace_bytes INTEGER NOT NULL DEFAULT 0 CHECK(trace_bytes>=0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS n2r_calls (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('boot','work_start','work','work_end','end')),
    sequence INTEGER NOT NULL CHECK(sequence>=0), tool TEXT NOT NULL, version TEXT NOT NULL,
    argument_hash TEXT NOT NULL, arguments_json TEXT NOT NULL,
    read_only INTEGER NOT NULL CHECK(read_only IN (0,1)), idempotent INTEGER NOT NULL CHECK(idempotent IN (0,1)),
    state TEXT NOT NULL CHECK(state IN ('pending','completed')), result_json TEXT, reconciliation TEXT,
    started_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY(project,agent,run_id,call_id), UNIQUE(project,agent,run_id,phase,sequence),
    FOREIGN KEY(project,agent,run_id) REFERENCES n2r_runs(project,agent,id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS n2r_leases (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, nonce TEXT NOT NULL,
    process_id INTEGER NOT NULL CHECK(process_id>0), expires_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent))`,
  `CREATE TABLE IF NOT EXISTS n2r_checkpoints (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL,
    progress_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project,agent,run_id),
    FOREIGN KEY(project,agent,run_id) REFERENCES n2r_runs(project,agent,id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_n2r_runs_status ON n2r_runs(project,agent,state,updated_at,id)`,
];
