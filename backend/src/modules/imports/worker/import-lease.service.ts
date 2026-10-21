import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

/**
 * Durable leases for import work.
 *
 * A lease is not a lock. A lock assumes the holder will release it, and an
 * import worker is exactly the kind of process that dies without releasing
 * anything — a job container is evicted, a deploy rolls, a node vanishes. So
 * ownership is expressed as "mine until this instant", extended by a heartbeat,
 * and an expired lease is safe for another worker to take.
 *
 * What makes stealing safe is not the lease at all: it is the checkpoints. A
 * new owner resumes from the last durably committed batch, so the worst case of
 * a mis-timed steal is that one batch is attempted twice and the second attempt
 * discovers the checkpoint already exists.
 *
 * The steal is a single conditional UPDATE. Reading the row and then writing it
 * would leave a window in which two workers both saw an expired lease; doing it
 * in one statement means the database picks the winner.
 */

export const LEASE_DURATION_MS = 60_000;
/**
 * How often a worker SHOULD beat. Advisory: the worker calls `beat()` itself
 * between batches — nothing in this file schedules anything.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface LeaseHandle {
  table: 'import_analyses' | 'import_executions';
  id: string;
  owner: string;
}

@Injectable()
export class ImportLeaseService {
  private readonly logger = new Logger(ImportLeaseService.name);

  constructor(private readonly em: EntityManager) {}

  /**
   * Claim work whose lease is free or expired.
   *
   * `now()` is the database's clock, deliberately: worker clocks drift, and a
   * worker with a fast clock would otherwise steal live leases.
   */
  async acquire(
    table: LeaseHandle['table'],
    id: string,
    owner: string,
    durationMs = LEASE_DURATION_MS,
  ): Promise<boolean> {
    const seconds = Math.ceil(durationMs / 1000);
    const result = await this.em.getConnection().execute(
      `update ${table}
          set lease_owner = ?,
              lease_expires_at = now() + (? || ' seconds')::interval,
              heartbeat_at = now(),
              updated_at = now()
        where id = ?
          and (lease_owner is null or lease_expires_at is null or lease_expires_at < now())
        returning id`,
      [owner, String(seconds), id],
    );
    return Array.isArray(result) && result.length === 1;
  }

  /**
   * Extend a lease we still hold.
   *
   * Returns false when the lease was taken while we were working — the correct
   * response to which is to stop, not to keep writing. A worker that ignores a
   * lost heartbeat is the one case where two workers really can collide.
   */
  async heartbeat(
    table: LeaseHandle['table'],
    id: string,
    owner: string,
    durationMs = LEASE_DURATION_MS,
  ): Promise<boolean> {
    const seconds = Math.ceil(durationMs / 1000);
    const result = await this.em.getConnection().execute(
      `update ${table}
          set lease_expires_at = now() + (? || ' seconds')::interval,
              heartbeat_at = now(),
              updated_at = now()
        where id = ? and lease_owner = ?
        returning id`,
      [String(seconds), id, owner],
    );
    return Array.isArray(result) && result.length === 1;
  }

  /** Release voluntarily, so the next worker does not wait out the expiry. */
  async release(table: LeaseHandle['table'], id: string, owner: string): Promise<void> {
    await this.em.getConnection().execute(
      `update ${table}
          set lease_owner = null, lease_expires_at = null, updated_at = now()
        where id = ? and lease_owner = ?`,
      [id, owner],
    );
  }

  /**
   * Mark work whose owner vanished as abandoned, so an operator sees the truth
   * rather than a row stuck in RUNNING forever — the failure the legacy import
   * history had, where an interrupted run stayed RUNNING with no reconciliation.
   */
  async reapAbandoned(table: LeaseHandle['table']): Promise<number> {
    const status = table === 'import_executions' ? 'ABANDONED' : 'FAILED';
    const reasonColumn = 'failure_reason';
    const result = await this.em.getConnection().execute(
      `update ${table}
          set status = ?,
              ${reasonColumn} = coalesce(${reasonColumn},
                'The worker stopped without finishing. Resume from the last completed batch.'),
              lease_owner = null,
              lease_expires_at = null,
              updated_at = now()
        where status in ('QUEUED','RUNNING')
          and lease_expires_at is not null
          and lease_expires_at < now()
        returning id`,
      [status],
    );
    const n = Array.isArray(result) ? result.length : 0;
    if (n > 0) this.logger.warn(`Reaped ${n} abandoned ${table} row(s) whose lease expired`);
    return n;
  }

  /**
   * Run `work` while holding a lease, releasing it afterwards.
   *
   * The heartbeat is CALLER-DRIVEN, not a timer. A timer would be background
   * machinery with no HTTP verb, which maintenance mode cannot refuse — the
   * P5-X1 census forbids exactly that, and it is right to: work that keeps
   * running through a maintenance window is work nobody can stop.
   *
   * So the worker beats at its own safe points instead — between batches, and
   * between units inside a long one.
   *
   * This used to say "a couple of hundred rows cannot plausibly outlive a
   * 60-second lease". That was an assertion, and measurement disproved it: a
   * product row costs ten statements, so at a 40 ms round trip it is roughly
   * 400 ms and only ~74 rows fit safely. `BatchBudget` therefore sizes each
   * batch from what the previous one actually cost, rather than trusting a
   * constant. See `batch-lease-timing.pg.spec.ts`.
   *
   * Beat only OUTSIDE a transaction. This UPDATE runs on the same connection,
   * so beating inside an open transaction would hide the renewal from every
   * other worker until that transaction commits — the lease would look expired
   * to a reaper for the whole duration, which is the exact failure the
   * heartbeat exists to prevent.
   *
   * `beat()` returns false once the lease has been lost, and the worker is
   * expected to stop at its next safe point rather than keep writing.
   */
  async withLease<T>(
    table: LeaseHandle['table'],
    id: string,
    owner: string,
    work: (beat: () => Promise<boolean>) => Promise<T>,
  ): Promise<T | null> {
    const acquired = await this.acquire(table, id, owner);
    if (!acquired) return null;

    let lost = false;
    const beat = async (): Promise<boolean> => {
      if (lost) return false;
      const held = await this.heartbeat(table, id, owner).catch(() => true);
      // A FAILED heartbeat is not proof the lease is gone — a transient
      // database blip would otherwise abandon work that is still safely ours.
      // Only an explicit "someone else owns this" counts as loss.
      if (!held) {
        lost = true;
        this.logger.warn(`Lease on ${table}:${id} was lost by ${owner}`);
      }
      return held;
    };

    try {
      return await work(beat);
    } finally {
      await this.release(table, id, owner).catch(() => undefined);
    }
  }
}
