/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'async_hooks';
import { EntityManager } from '@mikro-orm/postgresql';
import { DisposablePg } from './pg-harness';
import { productFamilyLock, storePublicationLock } from '../src/modules/products/families/advisory-lock.util';

/**
 * Support for races that are driven, not hoped for.
 *
 * A concurrency test that starts two things and sleeps proves nothing: it
 * passes when the machine is fast and when the code is wrong. Every test built
 * on this holds one transaction at a named point, starts the other, and asks
 * PostgreSQL what the second is doing — finished, or waiting, and on whom.
 *
 * It also writes down what each transaction did. Every statement that takes a
 * lock or writes a row is attributed to the actor that issued it, in the order
 * issued, so a test can assert the ORDER a writer took its locks in rather
 * than only where it ended up. That order is the subject here: two writers
 * that take the same two locks in opposite orders deadlock, and the end state
 * of the survivor looks perfectly healthy.
 */

interface Entry {
  actor: string;
  label: string;
  issued: number;
  returned: number | null;
  failed?: string;
}

export interface Actor {
  settled: Promise<string>;
  state: { done: boolean; outcome: string };
}

export interface Gate {
  /** Called by the held transaction when it reaches the point. */
  at: () => void;
  /** Resolves once the point has been reached. */
  reached: Promise<void>;
  /** Lets the held transaction go. */
  release: () => void;
  /** What the held transaction waits on. */
  until: Promise<void>;
}

export const gateOf = (): Gate => {
  let at!: () => void;
  const reached = new Promise<void>((resolve) => (at = resolve));
  let release!: () => void;
  const until = new Promise<void>((resolve) => (release = resolve));
  return { at, reached, release, until };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded, so a test that is wrong fails instead of hanging the suite. */
export const within = async (promise: Promise<string>, ms: number, what: string): Promise<string> =>
  Promise.race([promise, sleep(ms).then(() => `${what} DID NOT SETTLE within ${ms} ms`)]);

const ROW_WRITE = /^(UPDATE|INSERT|DELETE) /;
const ROW_LOCK = /^ROW LOCK /;

export class RaceRecorder {
  private readonly als = new AsyncLocalStorage<{ actor: string }>();
  private clock = 0;
  private entries: Entry[] = [];
  private names = new Map<string, string>();
  private lockNames = new Map<string, string>();
  private pids = new Map<string, number>();
  private readonly observer: EntityManager;

  constructor(private readonly pg: DisposablePg) {
    this.observer = pg.orm.em.fork() as EntityManager;
    this.install();
  }

  /** Forget the previous test. Names are per test, because ids are. */
  reset(): void {
    this.clock = 0;
    this.entries = [];
    this.names = new Map();
    this.lockNames = new Map();
    this.pids = new Map();
  }

  sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    return this.observer.execute(text, params);
  }

  nameStore(id: string, label: string): void {
    this.names.set(id, `store ${label}`);
    const key = storePublicationLock(id);
    this.lockNames.set(`${key.ns}:${key.key}`, `store ${label}`);
  }

  nameProduct(id: string, label: string): void {
    this.names.set(id, label);
    const key = productFamilyLock(id);
    this.lockNames.set(`${key.ns}:${key.key}`, `family ${label}`);
  }

  nameRow(id: string, label: string): void {
    this.names.set(String(id), label);
  }

  labelOf(id: string): string | undefined {
    return this.names.get(id);
  }

  note(actor: string, label: string): void {
    this.clock += 1;
    this.entries.push({ actor, label, issued: this.clock, returned: this.clock });
  }

  /** An actor: its statements are attributed to it, and it always settles to a value. */
  run(actor: string, work: () => Promise<unknown>): Actor {
    const state = { done: false, outcome: '' };
    const settled = this.als
      .run({ actor }, () => work())
      .then(
        (value: any) => (value && value.failedCount > 0 ? `REFUSED: ${value.failures?.[0]?.message}` : 'completed'),
        (err: any) =>
          `${err?.name ?? 'Error'}${err?.code ? ` [${err.code}]` : ''}: ${String(err?.message)
            .replace(/\s+/g, ' ')
            .slice(-200)}`,
      )
      .then((outcome) => {
        state.done = true;
        state.outcome = outcome;
        this.note(actor, `SETTLED — ${outcome}`);
        return outcome;
      });
    return { settled, state };
  }

  /** Statements issued inside `work` are attributed to `actor`, without making it an actor of its own. */
  as<T>(actor: string, work: () => Promise<T>): Promise<T> {
    return this.als.run({ actor }, work);
  }

  /** Did it finish, or is it waiting — and on whom? Asked of PostgreSQL, not inferred from a timer. */
  async settledOrBlocked(actor: string, state: { done: boolean; outcome: string }, limitMs = 10_000): Promise<string> {
    const until = Date.now() + limitMs;
    while (Date.now() < until) {
      if (state.done) return `finished: ${state.outcome}`;
      const pid = this.pids.get(actor);
      if (pid) {
        const [row] = await this.sql<{ blockers: number[]; wait: string | null }>(
          `select pg_blocking_pids(?::int) as blockers,
                  (select wait_event_type || ':' || wait_event from pg_stat_activity where pid = ?::int) as wait`,
          [pid, pid],
        );
        if (row.blockers.length > 0) {
          const verdict = `BLOCKED by ${row.blockers.map((blocker) => this.actorOf(blocker)).join(', ')} (${row.wait})`;
          this.note(actor, verdict);
          return verdict;
        }
      }
      await sleep(50);
    }
    return `neither finished nor blocked within ${limitMs} ms`;
  }

  /** Advisory keys `actor`'s backend holds right now, by name. */
  async advisoryHeldBy(actor: string): Promise<string[]> {
    const pid = this.pids.get(actor);
    if (!pid) return [];
    const rows = await this.sql<{ classid: string; objid: string; granted: boolean }>(
      `select classid::bigint as classid, objid::bigint as objid, granted
         from pg_locks where locktype = 'advisory' and pid = ?::int and objsubid = 2`,
      [pid],
    );
    const signed = (value: string) => {
      const n = Number(value);
      return n >= 2 ** 31 ? n - 2 ** 32 : n;
    };
    return rows
      .filter((row) => row.granted)
      .map((row) => {
        // The two-key form stores the namespace in classid and the key in objid.
        const id = `${signed(row.classid)}:${signed(row.objid)}`;
        return this.lockNames.get(id) ?? `unnamed ${id}`;
      })
      .sort();
  }

  /**
   * Every violation of the canonical order by one actor, per transaction:
   *
   *   - a store key (namespace 1) first taken after a family key (namespace 2);
   *   - any key first taken after that transaction had locked a row — with
   *     `FOR SHARE` or `FOR UPDATE`, a statement the recorder labels;
   *   - any key first taken after that transaction had written a row.
   *
   * A key nobody named is the key of a row that transaction created itself.
   * Nothing else can see that row, so nothing can wait on its key, and it is
   * exempt from the last two rules — which is the one exemption the design has.
   *
   * A row lock the recorder does not label — the `FOR KEY SHARE` a foreign-key
   * check takes, the lock a trigger takes — is not seen, and a key taken after
   * one of those is not reported.
   */
  orderViolations(actor: string): string[] {
    const violations: string[] = [];
    let held = new Set<string>();
    let familyHeld = false;
    let locked: string | null = null;
    let wrote: string | null = null;
    for (const entry of this.entries.filter((candidate) => candidate.actor === actor)) {
      if (entry.label.startsWith('BEGIN')) {
        held = new Set();
        familyHeld = false;
        locked = null;
        wrote = null;
        continue;
      }
      // A row lock that was refused (NOWAIT) took nothing. A key that was
      // asked for and refused — a deadlock, a lock timeout — was still asked
      // for out of order, and counts.
      if (entry.failed && ROW_LOCK.test(entry.label)) continue;
      if (ROW_LOCK.test(entry.label)) {
        locked = locked ?? entry.label;
        continue;
      }
      if (ROW_WRITE.test(entry.label)) {
        wrote = wrote ?? entry.label;
        continue;
      }
      if (!entry.label.startsWith('ADVISORY ')) continue;
      for (const key of entry.label.slice('ADVISORY '.length).split(' + ')) {
        const fresh = !held.has(key);
        held.add(key);
        if (!fresh) continue;
        const own = key.startsWith('ns') && key.includes(' key ');
        if (key.startsWith('ns1 ') && familyHeld) violations.push(`${key} taken AFTER a family key was held`);
        if (locked && !own) violations.push(`${key} taken AFTER a row lock was held (${locked})`);
        if (wrote && !own) violations.push(`${key} taken AFTER a row was written (${wrote})`);
        if (key.startsWith('ns2 ')) familyHeld = true;
      }
    }
    return violations;
  }

  /** The labels one actor issued, in order — for asserting a sequence outright. */
  sequenceOf(actor: string): string[] {
    return this.entries
      .filter((entry) => entry.actor === actor)
      .sort((a, b) => a.issued - b.issued)
      .map((entry) => entry.label);
  }

  /** What everybody did, interleaved as it happened. Put it in a failure message. */
  timeline(): string {
    const lines: { at: number; text: string }[] = [];
    for (const entry of this.entries) {
      const waited = entry.returned !== null && entry.returned > entry.issued + 1;
      const never = entry.returned === null;
      lines.push({
        at: entry.issued,
        text: `${entry.actor.padEnd(8)} ${entry.label}${waited || never ? '  … issued, WAITING' : ''}${
          entry.failed && !waited ? `  ✗ ${entry.failed}` : ''
        }`,
      });
      if (waited) {
        lines.push({
          at: entry.returned as number,
          text: `${entry.actor.padEnd(8)}   ↳ ${entry.failed ? `FAILED: ${entry.failed}` : 'granted'}: ${entry.label}`,
        });
      }
    }
    return lines
      .sort((a, b) => a.at - b.at)
      .map((line, index) => `${String(index + 1).padStart(2)}. ${line.text}`)
      .join('\n');
  }

  private actorOf(pid: number): string {
    return Array.from(this.pids.entries()).find(([, value]) => value === pid)?.[0] ?? `pid ${pid}`;
  }

  private named(values: unknown[]): string {
    return Array.from(new Set(values.map((value) => this.names.get(String(value))).filter(Boolean))).join(', ');
  }

  /**
   * The rows a statement addresses: the bindings of its WHERE clause, not of
   * its SET clause. `update "products" set "parent_id" = ? … where "id" = ?`
   * binds the card's id as a value and the member's id as the row; the row is
   * the member. Bindings are positional, so the ones before ` where ` belong
   * to the SET clause and are skipped.
   */
  private addressed(q: string, bindings: unknown[]): string {
    const at = q.toLowerCase().indexOf(' where ');
    if (at === -1) return this.named(bindings);
    const before = (q.slice(0, at).match(/\?/g) ?? []).length;
    return this.named(bindings.slice(before));
  }

  /** The table a row-lock statement reads from. */
  private lockedTable(q: string): string {
    return /from "?([a-z_]+)"?/i.exec(q)?.[1] ?? 'products';
  }

  private keyName(ns: number, key: number): string {
    return `ns${ns} ${this.lockNames.get(`${ns}:${key}`) ?? `key ${key}`}`;
  }

  /** What a statement is, in the terms a test asserts on — or null for a read that locks nothing. */
  private describe(text: string, bindings: unknown[]): string | null {
    const q = text.replace(/\s+/g, ' ').trim();
    if (/pg_advisory_xact_lock\(u\.ns, u\.key\)/i.test(q)) {
      const parse = (value: unknown) =>
        String(value)
          .replace(/[{}]/g, '')
          .split(',')
          .filter((part) => part !== '')
          .map(Number);
      const namespaces = parse(bindings[0]);
      const keys = parse(bindings[1]);
      // Listed in the order the statement's own ORDER BY takes them, which is
      // not the order they were handed over in. That it IS the order is what
      // `import-lock-order.pg.spec.ts` proves; this only writes it down.
      const pairs = namespaces.map((ns, index) => ({ ns, key: keys[index] }));
      pairs.sort((a, b) => (a.ns !== b.ns ? a.ns - b.ns : a.key - b.key));
      return `ADVISORY ${pairs.map((pair) => this.keyName(pair.ns, pair.key)).join(' + ')}`;
    }
    if (/pg_advisory_xact_lock\(\?::int4, \?::int4\)/i.test(q)) {
      const [ns, key] = bindings as number[];
      return `ADVISORY ${this.keyName(ns, key)}`;
    }
    if (/^set local lock_timeout/i.test(q)) return `SET ${q.slice('set local '.length)}`;
    if (/for share/i.test(q)) {
      const nowait = /nowait/i.test(q) ? ' NOWAIT' : '';
      return `ROW LOCK FOR SHARE${nowait} on ${this.lockedTable(q)} [${this.addressed(q, bindings)}]`;
    }
    if (/for update/i.test(q)) {
      const nowait = /nowait/i.test(q) ? ' NOWAIT' : '';
      return `ROW LOCK FOR UPDATE${nowait} on ${this.lockedTable(q)} [${this.addressed(q, bindings)}]`;
    }
    if (/^delete from "?store_products"?/i.test(q)) return `DELETE store_products [${this.named(bindings)}]`;
    if (/^insert into "?store_products"?/i.test(q)) return `INSERT store_products [${this.named(bindings)}]`;
    if (/^update "?store_products"?/i.test(q)) return `UPDATE store_products [${this.addressed(q, bindings)}]`;
    if (/^update "?products"?/i.test(q)) return `UPDATE products [${this.addressed(q, bindings)}]`;
    if (/^insert into "?products"?/i.test(q)) return `INSERT products`;
    if (/count\(\*\)/i.test(q) && /parent_id/i.test(q)) return `READ child count of [${this.named(bindings)}]`;
    return null;
  }

  private install(): void {
    const connection: any = this.pg.orm.em.getDriver().getConnection();
    const execute = connection.execute.bind(connection);
    connection.execute = async (queryOrKnex: any, params: any[] = [], method: any = 'all', ctx: any, lc: any) => {
      const actor = this.als.getStore()?.actor;
      if (!actor) return execute(queryOrKnex, params, method, ctx, lc);
      const compiled = typeof queryOrKnex === 'string' ? null : queryOrKnex.toSQL();
      const label = this.describe(compiled ? compiled.sql : queryOrKnex, compiled ? compiled.bindings : params);
      if (!label) return execute(queryOrKnex, params, method, ctx, lc);
      this.clock += 1;
      const entry: Entry = { actor, label, issued: this.clock, returned: null };
      this.entries.push(entry);
      try {
        const out = await execute(queryOrKnex, params, method, ctx, lc);
        this.clock += 1;
        entry.returned = this.clock;
        return out;
      } catch (err: any) {
        this.clock += 1;
        entry.returned = this.clock;
        entry.failed = `${err?.code ? `[${err.code}] ` : ''}${String(err?.message).replace(/\s+/g, ' ').slice(-90)}`;
        throw err;
      }
    };
    const begin = connection.begin.bind(connection);
    connection.begin = async (...args: any[]) => {
      const trx = await begin(...args);
      const actor = this.als.getStore()?.actor;
      if (actor) {
        const [row] = await execute('select pg_backend_pid() as pid', [], 'all', trx);
        this.pids.set(actor, Number(row.pid));
        this.note(actor, 'BEGIN');
      }
      return trx;
    };
    for (const verb of ['commit', 'rollback'] as const) {
      const original = connection[verb].bind(connection);
      connection[verb] = async (...args: any[]) => {
        const actor = this.als.getStore()?.actor;
        const out = await original(...args);
        if (actor) this.note(actor, verb.toUpperCase());
        return out;
      };
    }
  }
}
