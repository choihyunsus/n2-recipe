// A scoped nonce fences persistence when an expired or dead process is replaced.
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from './run-types';

const LEASE_MS = 30000;
interface LeaseRow {
  nonce: string;
  process_id: number;
  expires_at: number;
}

export class RunLease {
  readonly nonce = randomUUID();
  private timer?: NodeJS.Timeout;
  readonly controller = new AbortController();

  constructor(
    private readonly connection: SqlConnection,
    private readonly scope: readonly string[],
    readonly runId: string,
  ) {
    connection.transaction(() => {
      const existing = connection.query<LeaseRow>(
        'SELECT nonce,process_id,expires_at FROM n2r_leases WHERE project=? AND agent=?',
        scope,
      )[0];
      if (existing && existing.expires_at > Date.now() && processAlive(existing.process_id))
        throw new Error('This project and agent already have an active N2R operation');
      connection.execute(
        `INSERT INTO n2r_leases(project,agent,run_id,nonce,process_id,expires_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(project,agent) DO UPDATE SET run_id=excluded.run_id,nonce=excluded.nonce,
         process_id=excluded.process_id,expires_at=excluded.expires_at`,
        [...scope, runId, this.nonce, process.pid, Date.now() + LEASE_MS],
      );
    });
    this.timer = setInterval(() => this.renew(), LEASE_MS / 3);
    this.timer.unref();
  }

  assert(): void {
    this.controller.signal.throwIfAborted();
    const row = this.connection.query<LeaseRow>(
      'SELECT nonce,process_id,expires_at FROM n2r_leases WHERE project=? AND agent=?',
      this.scope,
    )[0];
    if (!row || row.nonce !== this.nonce || row.expires_at <= Date.now())
      throw new Error('N2R execution lease was lost or expired');
  }

  release(): void {
    clearInterval(this.timer);
    this.controller.abort(new Error('N2R operation has ended'));
    this.connection.execute('DELETE FROM n2r_leases WHERE project=? AND agent=? AND nonce=?', [
      ...this.scope,
      this.nonce,
    ]);
  }

  private renew(): void {
    try {
      this.connection.transaction(() => {
        this.assert();
        this.connection.execute(
          'UPDATE n2r_leases SET expires_at=? WHERE project=? AND agent=? AND nonce=?',
          [Date.now() + LEASE_MS, ...this.scope, this.nonce],
        );
      });
    } catch (error) {
      clearInterval(this.timer);
      this.controller.abort(error);
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
