import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * EVERY GUARD #293 INTENDS TO INSTALL IS ACTUALLY THERE (#293).
 *
 * This suite exists because one of them was NOT, and nothing said so.
 *
 * The location triggers were originally named `wegox_<table>_<column>_removed_store`
 * with an `_ins` / `_upd` suffix. For `inventory_transfers.destination_location_id`
 * that is 67 characters, and PostgreSQL truncates an identifier at 63 bytes
 * without a word of complaint — so both suffixed names became the same string,
 * the `drop trigger if exists "<…>_upd"` removed the INSERT trigger that had
 * just been created, and the destination INSERT guard was simply absent. The
 * migration reported success. A transfer INTO a removed branch's location would
 * have been accepted.
 *
 * Behavioural tests did not catch it: `store-removal.pg.spec.ts` exercises
 * BALANCES at a removed location, which had its own intact trigger, and no case
 * happened to insert a transfer pointed at one. A missing guard is invisible
 * until precisely the operation it guards is tried, which is why this suite
 * counts the installed objects against the intended list instead of hoping some
 * behavioural case happens to cover each one.
 *
 * It is written to fail on the NEXT such omission too: the expected sets are
 * spelled out, so adding a table to the migration without adding it here — or
 * adding one here that the migration does not create — is a failure either way.
 */
d('#293 · the store lifecycle triggers are all installed (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  /** The fourteen tables guarded through their own `store_id`. */
  const STORE_GUARDED = [
    'api_keys',
    'discount_codes',
    'integration_requests',
    'inventory_backorders',
    'inventory_locations',
    'invoices',
    'sales_orders',
    'store_assets',
    'store_contents',
    'store_field_settings',
    'store_popups',
    'store_products',
    'supplier_orders',
    'users',
  ];

  /**
   * The four (table, column) pairs guarded through `inventory_locations`.
   * `inventory_entries` is deliberately not among them — the ledger is retained
   * history and the blocker never counts it; see the migration header.
   */
  const LOCATION_GUARDED = [
    'wegox_inv_balances_loc_removed_store',
    'wegox_inv_reservations_loc_removed_store',
    'wegox_inv_transfers_src_removed_store',
    'wegox_inv_transfers_dst_removed_store',
  ];

  const triggersFor = async (fn: string): Promise<string[]> => {
    const rows = await em.execute<{ tgname: string }[]>(
      `select t.tgname from pg_trigger t
         join pg_proc p on p.oid = t.tgfoid
        where p.proname = ? and not t.tgisinternal
        order by t.tgname`,
      [fn],
    );
    return rows.map((row) => row.tgname);
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('installs both guard functions and nothing else in that namespace', async () => {
    const rows = await em.execute<{ proname: string }[]>(
      `select proname from pg_proc where proname like 'wegox_refuse%removed_store%' order by proname`,
    );
    expect(rows.map((row) => row.proname)).toEqual([
      'wegox_refuse_dependency_on_removed_store',
      'wegox_refuse_location_dependency_on_removed_store',
    ]);
  });

  it('guards all fourteen store_id tables, on INSERT and on UPDATE', async () => {
    const installed = await triggersFor('wegox_refuse_dependency_on_removed_store');
    const expected = STORE_GUARDED.flatMap((table) => [
      `wegox_${table}_removed_store_ins`,
      `wegox_${table}_removed_store_upd`,
    ]).sort();
    expect(installed).toEqual(expected);
    expect(installed).toHaveLength(28);
  });

  it('guards all four location columns, on INSERT and on UPDATE', async () => {
    // THE CASE THAT WAS MISSING. Both halves of every pair are named, so a
    // truncation that collapses two names into one shows up as a short list
    // rather than as a silently weaker schema.
    const installed = await triggersFor('wegox_refuse_location_dependency_on_removed_store');
    const expected = LOCATION_GUARDED.flatMap((base) => [`${base}_ins`, `${base}_upd`]).sort();
    expect(installed).toEqual(expected);
    expect(installed).toHaveLength(8);
  });

  it('no trigger name is at PostgreSQL’s truncation limit', async () => {
    // The root cause, asserted directly rather than only through its symptom:
    // a name AT 63 bytes is one that was probably cut, and a name over it is
    // impossible to observe because the catalogue already holds the cut form.
    const all = [
      ...(await triggersFor('wegox_refuse_dependency_on_removed_store')),
      ...(await triggersFor('wegox_refuse_location_dependency_on_removed_store')),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const name of all) {
      expect({ name, bytes: Buffer.byteLength(name, 'utf8') }).toEqual({
        name,
        bytes: expect.any(Number),
      });
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThan(63);
    }
  });

  it('the ledger is NOT guarded — inventory_entries carries no store trigger at all', async () => {
    const rows = await em.execute<{ tgname: string }[]>(
      `select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'inventory_entries' and t.tgname like 'wegox_%removed_store%' and not t.tgisinternal`,
    );
    expect(rows).toEqual([]);
  });

  it('each guard trigger fires BEFORE the write, not after it', async () => {
    // A guard that ran AFTER the row landed would still raise, but it would
    // raise having already taken the write's locks in a different order — and
    // on a statement-level trigger it would not see `new` at all. The timing is
    // part of the contract, so it is asserted rather than assumed.
    const rows = await em.execute<{ tgname: string; timing: string; level: string }[]>(
      `select t.tgname,
              case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end as timing,
              case when (t.tgtype & 1) <> 0 then 'ROW' else 'STATEMENT' end as level
         from pg_trigger t
         join pg_proc p on p.oid = t.tgfoid
        where p.proname in (?) and not t.tgisinternal`,
      [['wegox_refuse_dependency_on_removed_store', 'wegox_refuse_location_dependency_on_removed_store']],
    );
    expect(rows).toHaveLength(36);
    for (const row of rows) {
      expect({ tgname: row.tgname, timing: row.timing, level: row.level }).toEqual({
        tgname: row.tgname,
        timing: 'BEFORE',
        level: 'ROW',
      });
    }
  });
});
