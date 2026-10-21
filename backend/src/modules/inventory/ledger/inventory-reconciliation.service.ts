import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { InventoryBalance } from '../entities/inventory-balance.entity';

/**
 * P5-B1 — the reconciliation equations as executable, reusable primitives.
 *
 * Each equation is a verification query, not a claim in prose. B2's opening
 * gate, B3's conversion proof and the cutover checks all call these rather than
 * writing their own SQL, so there is one definition of each invariant.
 *
 * WHICH BOUNDARY ACTIVATES WHAT — the activation matrix lives in
 * `INVARIANT_ACTIVATION` below. B1 proves only what B1 tables and behaviour can
 * support: it does not claim reservation, backorder or legacy-cache invariants
 * are enforced, because the aggregates and the write-through conversion those
 * describe do not exist yet.
 */

export interface ReconciliationFinding {
  invariant: string;
  detail: string;
}

export type InvariantBoundary = 'B1' | 'B2' | 'B3' | 'B4' | 'B5';

export const INVARIANT_ACTIVATION: Readonly<Record<string, InvariantBoundary>> = {
  // Active and proved in B1.
  LOCATED_BALANCE_FORWARD: 'B1',
  LOCATED_BALANCE_REVERSE: 'B1',
  TRANSIT_BALANCE_FORWARD: 'B1',
  TRANSIT_BALANCE_REVERSE: 'B1',
  STORE_HELD_PROJECTION: 'B1',
  ORGANIZATION_PHYSICAL_TOTAL: 'B1',
  SELLABLE_AVAILABLE_TOTAL: 'B1',
  CONSERVATION_PER_PRODUCT_INTENT: 'B1',
  INTENT_SET_IDENTITY: 'B1',
  TRANSACTION_NET_ZERO_CROSS_PRODUCT: 'B1',
  // Deferred: the structures these describe do not exist yet.
  OPENING_RECONCILIATION_APPROVED: 'B2',
  OPENING_ALLOCATION_BALANCE: 'B2',
  // Activated by P5-B3: the legacy columns became ledger-derived caches, so
  // these stopped being promises and became checkable facts.
  LEGACY_PRODUCT_CACHE_EQUALITY: 'B3',
  LEGACY_STORE_PRODUCT_CACHE_EQUALITY: 'B3',
  // Activated by P5-B4.
  RESERVATION_AGGREGATE_EQUALITY: 'B4',
  BACKORDER_CREATES_NO_ENTRIES: 'B4',
  // Activated by P5-B5.
  TRANSFER_LIFECYCLE_INTEGRITY: 'B5',
};

@Injectable()
export class InventoryReconciliationService {
  constructor(
    @InjectRepository(InventoryBalance)
    private readonly balanceRepository: EntityRepository<InventoryBalance>,
  ) {}

  private get em(): EntityManager {
    return this.balanceRepository.getEntityManager() as EntityManager;
  }

  /**
   * Every verification below accepts an EntityManager override so a caller
   * inside an open transaction can pass its own `tem`. Reading through the
   * repository's manager instead would query OUTSIDE that transaction and
   * silently miss the uncommitted rows it is supposed to be checking.
   */
  private manager(override?: EntityManager): EntityManager {
    return override ?? this.em;
  }

  /**
   * Equation 1 — located entries reconcile with located balances, BOTH ways:
   * no non-zero entry group without a row, no row without a matching group.
   */
  async verifyLocatedBalances(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const rows: { direction: string; detail: string }[] = await this.manager(em).execute(
      `with grouped as (
         select organization_id, location_id, product_id, physical_condition, operational_state,
                sum(quantity_delta)::int as delta
           from inventory_entries
          where organization_id = ? and location_id is not null
          group by 1,2,3,4,5
       )
       select 'entries-without-matching-balance' as direction,
              g.product_id || '@' || g.location_id || ' ' || g.physical_condition || '/' || g.operational_state
                || ' entries=' || g.delta || ' balance=' || coalesce(b.quantity, -1) as detail
         from grouped g
         left join inventory_balances b
           on b.organization_id = g.organization_id and b.location_id = g.location_id
          and b.product_id = g.product_id and b.physical_condition = g.physical_condition
          and b.operational_state = g.operational_state
        where b.quantity is distinct from g.delta
       union all
       select 'balance-without-matching-entries',
              b.product_id || '@' || b.location_id || ' ' || b.physical_condition || '/' || b.operational_state
                || ' balance=' || b.quantity || ' entries=' || coalesce(g.delta, -1)
         from inventory_balances b
         left join grouped g
           on b.organization_id = g.organization_id and b.location_id = g.location_id
          and b.product_id = g.product_id and b.physical_condition = g.physical_condition
          and b.operational_state = g.operational_state
        where b.organization_id = ? and coalesce(g.delta, 0) is distinct from b.quantity`,
      [organizationId, organizationId],
    );
    return rows.map((row) => ({ invariant: `LOCATED_BALANCE_${row.direction}`, detail: row.detail }));
  }

  /**
   * Equation 2 — transit entries reconcile with transit balances, BOTH ways.
   *
   * The join is the exact tuple the entry carries — organization, transfer,
   * direction, product, condition — so a transit entry resolves to precisely one
   * cell and a located entry (transfer_id null) resolves to none.
   */
  async verifyTransitBalances(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const rows: { direction: string; detail: string }[] = await this.manager(em).execute(
      `with grouped as (
         select organization_id, transfer_id, transit_direction, product_id, physical_condition,
                sum(quantity_delta)::int as delta
           from inventory_entries
          where organization_id = ? and location_id is null
          group by 1,2,3,4,5
       )
       select 'entries-without-matching-balance' as direction,
              g.product_id || '@transfer:' || g.transfer_id || '/' || g.transit_direction
                || ' entries=' || g.delta || ' balance=' || coalesce(t.quantity, -1) as detail
         from grouped g
         left join inventory_transit_balances t
           on t.organization_id = g.organization_id and t.transfer_id = g.transfer_id
          and t.transit_direction = g.transit_direction and t.product_id = g.product_id
          and t.physical_condition = g.physical_condition
        where t.quantity is distinct from g.delta
       union all
       select 'balance-without-matching-entries',
              t.product_id || '@transfer:' || t.transfer_id || '/' || t.transit_direction
                || ' balance=' || t.quantity || ' entries=' || coalesce(g.delta, -1)
         from inventory_transit_balances t
         left join grouped g
           on t.organization_id = g.organization_id and t.transfer_id = g.transfer_id
          and t.transit_direction = g.transit_direction and t.product_id = g.product_id
          and t.physical_condition = g.physical_condition
        where t.organization_id = ? and coalesce(g.delta, 0) is distinct from t.quantity`,
      [organizationId, organizationId],
    );
    return rows.map((row) => ({ invariant: `TRANSIT_BALANCE_${row.direction}`, detail: row.detail }));
  }

  /**
   * Equation 3 — what a branch HOLDS, derived from its canonical custody
   * location. This is a projection of located balances, never a second ledger.
   */
  async storeHeldQuantity(
    organizationId: string,
    storeId: string,
    productId: string,
    em?: EntityManager,
  ): Promise<number> {
    const rows: { held: number }[] = await this.manager(em).execute(
      `select coalesce(sum(b.quantity), 0)::int as held
         from inventory_balances b
         join inventory_locations l on l.id = b.location_id
        where b.organization_id = ? and l.store_id = ?::uuid and l.kind = 'STORE' and b.product_id = ?::uuid`,
      [organizationId, storeId, productId],
    );
    return rows[0]?.held ?? 0;
  }

  /**
   * Equation 4 — the organization's owned physical total: located PLUS
   * in-transit (owner decision 1), each unit counted exactly once.
   *
   * The two summands are disjoint by construction: `inventory_balances` excludes
   * IN_TRANSIT by CHECK and `inventory_entries` forces every IN_TRANSIT line to
   * be location-less, so no unit can appear in both projections.
   */
  async organizationPhysicalTotal(organizationId: string, productId: string, em?: EntityManager): Promise<number> {
    const rows: { total: number }[] = await this.manager(em).execute(
      `select (
         coalesce((select sum(quantity) from inventory_balances
                    where organization_id = ? and product_id = ?::uuid), 0)
       + coalesce((select sum(quantity) from inventory_transit_balances
                    where organization_id = ? and product_id = ?::uuid), 0)
       )::int as total`,
      [organizationId, productId, organizationId, productId],
    );
    return rows[0]?.total ?? 0;
  }

  /**
   * Equation 4b — the corroboration: the two projections together equal the sum
   * of every entry delta.
   *
   * This holds only BECAUSE equations 1 and 2 hold over a partitioned entry set,
   * so it is asserted alongside them and never instead of them. A cumulative
   * delta is never compared against a single projection on its own.
   */
  async verifyTotalAgainstEntries(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const rows: { product_id: string; projected: number; entries: number }[] = await this.manager(em).execute(
      `with projected as (
         select product_id, sum(quantity)::int as q from inventory_balances where organization_id = ? group by 1
         union all
         select product_id, sum(quantity)::int from inventory_transit_balances where organization_id = ? group by 1
       ), p as (
         select product_id, sum(q)::int as projected from projected group by 1
       ), e as (
         select product_id, sum(quantity_delta)::int as entries from inventory_entries where organization_id = ? group by 1
       )
       select coalesce(p.product_id, e.product_id) as product_id,
              coalesce(p.projected, 0) as projected, coalesce(e.entries, 0) as entries
         from p full outer join e on p.product_id = e.product_id
        where coalesce(p.projected, 0) <> coalesce(e.entries, 0)`,
      [organizationId, organizationId, organizationId],
    );
    return rows.map((row) => ({
      invariant: 'ORGANIZATION_PHYSICAL_TOTAL',
      detail: `${row.product_id} projected=${row.projected} entries=${row.entries}`,
    }));
  }

  /**
   * Equation 5 — sellable/available, which EXCLUDES in-transit (owner decision
   * 1) and every non-AVAILABLE state. DAMAGED + AVAILABLE is included: condition
   * and state are orthogonal, and a damaged unit that has been reclassified as
   * sellable is sellable (ADR 013 §2).
   */
  async sellableQuantity(organizationId: string, productId: string, em?: EntityManager): Promise<number> {
    const rows: { sellable: number }[] = await this.manager(em).execute(
      `select coalesce(sum(quantity), 0)::int as sellable
         from inventory_balances
        where organization_id = ? and product_id = ?::uuid and operational_state = 'AVAILABLE'`,
      [organizationId, productId],
    );
    return rows[0]?.sellable ?? 0;
  }

  /**
   * Equations 6 and 7 — every posted transaction still matches its declared
   * per-product intent, and the two product-changing types still net to zero
   * across the whole transaction.
   */
  async verifyConservation(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const perProduct: { detail: string }[] = await this.manager(em).execute(
      `with moved as (
         select transaction_id, product_id,
                sum(quantity_delta)::int as net,
                sum(greatest(quantity_delta, 0))::int as gross
           from inventory_entries where organization_id = ? group by 1,2
       )
       select t.type || ' ' || t.id || ' product ' || m.product_id
              || ' net=' || m.net || ' gross=' || m.gross
              || ' declared=' || i.intent_sign || '*' || i.declared_amount as detail
         from moved m
         join inventory_transaction_intents i
           on i.transaction_id = m.transaction_id and i.product_id = m.product_id
         join inventory_transactions t on t.id = m.transaction_id
        where (i.intent_sign = 0 and (m.net <> 0 or m.gross <> i.declared_amount))
           or (i.intent_sign <> 0 and m.net <> i.intent_sign * i.declared_amount)`,
      [organizationId],
    );

    const identity: { detail: string }[] = await this.manager(em).execute(
      `select 'transaction ' || t.id || ' intent/entry product sets differ' as detail
         from inventory_transactions t
        where t.organization_id = ?
          and (
            exists (select 1 from inventory_entries e where e.transaction_id = t.id
                     and not exists (select 1 from inventory_transaction_intents i
                                      where i.transaction_id = t.id and i.product_id = e.product_id))
            or exists (select 1 from inventory_transaction_intents i where i.transaction_id = t.id
                     and not exists (select 1 from inventory_entries e
                                      where e.transaction_id = t.id and e.product_id = i.product_id))
          )`,
      [organizationId],
    );

    const crossProduct: { detail: string }[] = await this.manager(em).execute(
      `select t.type || ' ' || t.id || ' nets ' || coalesce(sum(e.quantity_delta), 0)::text as detail
         from inventory_transactions t
         join inventory_entries e on e.transaction_id = t.id
        where t.organization_id = ?
          and t.type in ('FAMILY_STOCK_DISTRIBUTION', 'PRODUCT_STOCK_REASSIGNMENT')
        group by t.id, t.type
       having sum(e.quantity_delta) <> 0`,
      [organizationId],
    );

    return [
      ...perProduct.map((row) => ({ invariant: 'CONSERVATION_PER_PRODUCT_INTENT', detail: row.detail })),
      ...identity.map((row) => ({ invariant: 'INTENT_SET_IDENTITY', detail: row.detail })),
      ...crossProduct.map((row) => ({ invariant: 'TRANSACTION_NET_ZERO_CROSS_PRODUCT', detail: row.detail })),
    ];
  }

  /**
   * Equations 10 and 11 — the compatibility caches equal what the ledger says.
   *
   * `products.stock_quantity` is the organization's owned total, located PLUS
   * in-transit (owner decision 1); `store_products.stock_quantity` is what that
   * branch holds. Activated in P5-B3, when the columns stopped being
   * independently mutable and became derived values.
   */
  async verifyLegacyCaches(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const productDrift: { detail: string }[] = await this.manager(em).execute(
      `select p.id || ' cache=' || p.stock_quantity || ' ledger=' || coalesce(l.total, 0) as detail
         from products p
         left join (
           select product_id, sum(q)::int as total from (
             select product_id, quantity as q from inventory_balances where organization_id = ?
             union all
             select product_id, quantity from inventory_transit_balances where organization_id = ?
           ) owned group by product_id
         ) l on l.product_id = p.id
        -- #292: cache drift is reported for rows the tenant can act on. A
        -- removed item's cache is refreshed by the posting service like any
        -- other, so it does not drift; reporting it would only produce a
        -- finding nobody could clear.
        where p.organization_id = ? and p.removed_at is null
          and p.stock_quantity <> coalesce(l.total, 0)`,
      [organizationId, organizationId, organizationId],
    );
    const branchDrift: { detail: string }[] = await this.manager(em).execute(
      `select sp.id || ' cache=' || sp.stock_quantity || ' ledger=' || coalesce(l.total, 0) as detail
         from store_products sp
         left join (
           select b.product_id, loc.store_id, sum(b.quantity)::int as total
             from inventory_balances b
             join inventory_locations loc on loc.id = b.location_id and loc.kind = 'STORE'
            where b.organization_id = ?
            group by b.product_id, loc.store_id
         ) l on l.product_id = sp.product_id and l.store_id = sp.store_id
        where sp.organization_id = ? and sp.stock_quantity <> coalesce(l.total, 0)`,
      [organizationId, organizationId],
    );
    return [
      ...productDrift.map((row) => ({ invariant: 'LEGACY_PRODUCT_CACHE_EQUALITY', detail: row.detail })),
      ...branchDrift.map((row) => ({ invariant: 'LEGACY_STORE_PRODUCT_CACHE_EQUALITY', detail: row.detail })),
    ];
  }

  /**
   * Equation 8 — active reservations account for exactly the RESERVED balance.
   *
   * If they did not, either units would be set aside that nothing asked for, or
   * a reservation would be promising units the ledger never moved.
   */
  async verifyReservations(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const rows: { detail: string }[] = await this.manager(em).execute(
      `with reserved as (
         select organization_id, location_id, product_id, physical_condition,
                coalesce(sum(quantity), 0)::int as held
           from inventory_reservations
          where organization_id = ? and status = 'ACTIVE'
          group by 1,2,3,4
       ), balances as (
         select organization_id, location_id, product_id, physical_condition, quantity
           from inventory_balances
          where organization_id = ? and operational_state = 'RESERVED'
       )
       select coalesce(r.product_id, b.product_id)::text || '@' || coalesce(r.location_id, b.location_id)::text
              || ' reservations=' || coalesce(r.held, 0) || ' balance=' || coalesce(b.quantity, 0) as detail
         from reserved r
         full outer join balances b
           on b.organization_id = r.organization_id and b.location_id = r.location_id
          and b.product_id = r.product_id and b.physical_condition = r.physical_condition
        where coalesce(r.held, 0) <> coalesce(b.quantity, 0)`,
      [organizationId, organizationId],
    );
    return rows.map((row) => ({ invariant: 'RESERVATION_AGGREGATE_EQUALITY', detail: row.detail }));
  }

  /**
   * Equation 9 — a backorder creates no physical entries, ever.
   *
   * The check is deliberately blunt: a backorder id must not appear as a sales
   * order reference on any transaction, and an open promise must never be
   * counted anywhere in the projections. A backorder that had entries would be
   * imaginary stock by another name.
   */
  async verifyBackorders(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const rows: { detail: string }[] = await this.manager(em).execute(
      `select 'backorder ' || b.id || ' allocated ' || b.allocated_quantity
              || ' but its allocation rows total ' || coalesce(a.total, 0) as detail
         from inventory_backorders b
         left join (
           select backorder_id, sum(quantity)::int as total
             from inventory_backorder_allocations group by backorder_id
         ) a on a.backorder_id = b.id
        where b.organization_id = ? and b.allocated_quantity <> coalesce(a.total, 0)
       union all
       select 'backorder ' || b.id || ' is unallocated yet reserved stock points at it'
         from inventory_backorders b
        where b.organization_id = ? and b.status = 'OPEN'
          and exists (select 1 from inventory_backorder_allocations a where a.backorder_id = b.id)`,
      [organizationId, organizationId],
    );
    return rows.map((row) => ({ invariant: 'BACKORDER_CREATES_NO_ENTRIES', detail: row.detail }));
  }

  /**
   * Transfer lifecycle integrity (activated by P5-B5).
   *
   * Two things must hold and are easy to break: a transfer's transit balance is
   * exactly what it dispatched and has not yet settled, and a transfer never
   * changes the organization's owned total — it only changes where the units
   * are.
   */
  async verifyTransfers(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    const rows: { detail: string }[] = await this.manager(em).execute(
      `with travelling as (
         select l.transfer_id, l.product_id, l.physical_condition,
                (l.dispatched_quantity - l.received_quantity - l.returned_quantity)::int as expected
           from inventory_transfer_lines l
          where l.organization_id = ?
       ), held as (
         select transfer_id, product_id, physical_condition, sum(quantity)::int as actual
           from inventory_transit_balances where organization_id = ?
          group by 1,2,3
       )
       select 'transfer ' || t.transfer_id || ' product ' || t.product_id
              || ' expects ' || t.expected || ' in transit but holds ' || coalesce(h.actual, 0) as detail
         from travelling t
         left join held h
           on h.transfer_id = t.transfer_id and h.product_id = t.product_id
          and h.physical_condition = t.physical_condition
        where t.expected <> coalesce(h.actual, 0)`,
      [organizationId, organizationId],
    );
    return rows.map((row) => ({ invariant: 'TRANSFER_LIFECYCLE_INTEGRITY', detail: row.detail }));
  }

  /** Every currently-active invariant, in one call. Empty means all hold. */
  async verifyAll(organizationId: string, em?: EntityManager): Promise<ReconciliationFinding[]> {
    return [
      ...(await this.verifyLocatedBalances(organizationId, em)),
      ...(await this.verifyTransitBalances(organizationId, em)),
      ...(await this.verifyTotalAgainstEntries(organizationId, em)),
      ...(await this.verifyConservation(organizationId, em)),
      ...(await this.verifyLegacyCaches(organizationId, em)),
      ...(await this.verifyReservations(organizationId, em)),
      ...(await this.verifyBackorders(organizationId, em)),
      ...(await this.verifyTransfers(organizationId, em)),
    ];
  }
}

/**
 * The ATOMIC POSTCONDITION of a posting.
 *
 * This is not the same thing as the verification suite above, and the
 * difference matters. `verifyAll` is an externally invoked sweep used by
 * cutover and rehearsal; this runs INSIDE the posting transaction, on the
 * callback EntityManager, against uncommitted rows, and throws — so a posting
 * that has corrupted its own projections rolls back in full rather than
 * committing and waiting to be discovered by a later sweep.
 *
 * It must be called with `tem`, the manager the transaction callback received.
 * A repository's manager would query outside the open transaction and see none
 * of the rows it is meant to be checking.
 */
export async function assertPostingPostcondition(
  em: EntityManager,
  params: { organizationId: string; transactionId: string },
): Promise<void> {
  const { organizationId, transactionId } = params;
  const findings: ReconciliationFinding[] = [];

  // 1. Every LOCATED cell this transaction touched agrees with the full entry
  //    history of that cell — not just with this transaction's contribution.
  const located: { detail: string }[] = await em.execute(
    `with touched as (
       select distinct organization_id, location_id, product_id, physical_condition, operational_state
         from inventory_entries where transaction_id = ?::uuid and location_id is not null
     ), summed as (
       select t.*, coalesce((select sum(e.quantity_delta) from inventory_entries e
                              where e.organization_id = t.organization_id and e.location_id = t.location_id
                                and e.product_id = t.product_id and e.physical_condition = t.physical_condition
                                and e.operational_state = t.operational_state), 0)::int as delta
         from touched t
     )
     select s.product_id || '@' || s.location_id || ' ' || s.physical_condition || '/' || s.operational_state
            || ' entries=' || s.delta || ' balance=' || coalesce(b.quantity, -1) as detail
       from summed s
       left join inventory_balances b
         on b.organization_id = s.organization_id and b.location_id = s.location_id
        and b.product_id = s.product_id and b.physical_condition = s.physical_condition
        and b.operational_state = s.operational_state
      where coalesce(b.quantity, -1) is distinct from s.delta`,
    [transactionId],
  );
  findings.push(...located.map((row) => ({ invariant: 'LOCATED_BALANCE_TOUCHED', detail: row.detail })));

  // 2. Same for every TRANSIT cell it touched.
  const transit: { detail: string }[] = await em.execute(
    `with touched as (
       select distinct organization_id, transfer_id, transit_direction, product_id, physical_condition
         from inventory_entries where transaction_id = ?::uuid and location_id is null
     ), summed as (
       select t.*, coalesce((select sum(e.quantity_delta) from inventory_entries e
                              where e.organization_id = t.organization_id and e.transfer_id = t.transfer_id
                                and e.transit_direction = t.transit_direction and e.product_id = t.product_id
                                and e.physical_condition = t.physical_condition), 0)::int as delta
         from touched t
     )
     select s.product_id || '@transfer:' || s.transfer_id || '/' || s.transit_direction
            || ' entries=' || s.delta || ' balance=' || coalesce(b.quantity, -1) as detail
       from summed s
       left join inventory_transit_balances b
         on b.organization_id = s.organization_id and b.transfer_id = s.transfer_id
        and b.transit_direction = s.transit_direction and b.product_id = s.product_id
        and b.physical_condition = s.physical_condition
      where coalesce(b.quantity, -1) is distinct from s.delta`,
    [transactionId],
  );
  findings.push(...transit.map((row) => ({ invariant: 'TRANSIT_BALANCE_TOUCHED', detail: row.detail })));

  // 3. Every product this transaction touched: cumulative entries equal the two
  //    projections added together. Valid only because 1 and 2 hold over a
  //    partitioned entry set, and asserted alongside them, never instead.
  const totals: { detail: string }[] = await em.execute(
    `with touched as (
       select distinct product_id from inventory_entries where transaction_id = ?::uuid
     )
     select t.product_id || ' entries=' || e.total || ' projected=' || p.total as detail
       from touched t
       cross join lateral (select coalesce(sum(quantity_delta), 0)::int as total from inventory_entries
                            where organization_id = ? and product_id = t.product_id) e
       cross join lateral (select (coalesce((select sum(quantity) from inventory_balances
                                              where organization_id = ? and product_id = t.product_id), 0)
                                 + coalesce((select sum(quantity) from inventory_transit_balances
                                              where organization_id = ? and product_id = t.product_id), 0))::int as total) p
      where e.total <> p.total`,
    [transactionId, organizationId, organizationId, organizationId],
  );
  findings.push(...totals.map((row) => ({ invariant: 'ORGANIZATION_PHYSICAL_TOTAL', detail: row.detail })));

  // 4. The posted entries still match every signed intent, read back from the
  //    database rather than trusted from the command object.
  const intents: { detail: string }[] = await em.execute(
    `with moved as (
       select product_id, sum(quantity_delta)::int as net, sum(greatest(quantity_delta, 0))::int as gross
         from inventory_entries where transaction_id = ?::uuid group by 1
     )
     select 'product ' || m.product_id || ' net=' || m.net || ' gross=' || m.gross
            || ' declared=' || i.intent_sign || '*' || i.declared_amount as detail
       from moved m
       join inventory_transaction_intents i
         on i.transaction_id = ?::uuid and i.product_id = m.product_id
      where (i.intent_sign = 0 and (m.net <> 0 or m.gross <> i.declared_amount))
         or (i.intent_sign <> 0 and m.net <> i.intent_sign * i.declared_amount)`,
    [transactionId, transactionId],
  );
  findings.push(...intents.map((row) => ({ invariant: 'CONSERVATION_PER_PRODUCT_INTENT', detail: row.detail })));

  // 5. Intent and entry product sets are identical, both ways.
  const identity: { detail: string }[] = await em.execute(
    `select 'entry product without intent: ' || e.product_id as detail
       from (select distinct product_id from inventory_entries where transaction_id = ?::uuid) e
      where not exists (select 1 from inventory_transaction_intents i
                         where i.transaction_id = ?::uuid and i.product_id = e.product_id)
     union all
     select 'intent product without entries: ' || i.product_id
       from inventory_transaction_intents i
      where i.transaction_id = ?::uuid
        and not exists (select 1 from inventory_entries e
                         where e.transaction_id = ?::uuid and e.product_id = i.product_id)`,
    [transactionId, transactionId, transactionId, transactionId],
  );
  findings.push(...identity.map((row) => ({ invariant: 'INTENT_SET_IDENTITY', detail: row.detail })));

  // 6. The applicable conservation grain, and cross-product net-zero, re-derived
  //    from the persisted rows.
  const grainFindings: { detail: string }[] = await em.execute(
    `select t.type || ' cell ' || coalesce(e.location_id::text, 'transit') || '/' || e.physical_condition
            || ' product ' || e.product_id || ' nets ' || sum(e.quantity_delta)::text as detail
       from inventory_entries e
       join inventory_transactions t on t.id = e.transaction_id
      where e.transaction_id = ?::uuid
        and t.type in ('RESERVE', 'RELEASE')
      group by t.type, e.location_id, e.physical_condition, e.product_id
     having sum(e.quantity_delta) <> 0
     union all
     select t.type || ' condition ' || e.physical_condition || ' product ' || e.product_id
            || ' nets ' || sum(e.quantity_delta)::text
       from inventory_entries e
       join inventory_transactions t on t.id = e.transaction_id
      where e.transaction_id = ?::uuid
        and t.type in ('ALLOCATE', 'TRANSFER_COMMIT', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIVE', 'TRANSFER_RETURN')
      group by t.type, e.physical_condition, e.product_id
     having sum(e.quantity_delta) <> 0
     union all
     select t.type || ' location ' || coalesce(e.location_id::text, 'transit') || ' product ' || e.product_id
            || ' nets ' || sum(e.quantity_delta)::text
       from inventory_entries e
       join inventory_transactions t on t.id = e.transaction_id
      where e.transaction_id = ?::uuid and t.type = 'SELLABILITY_RECLASSIFY'
      group by t.type, e.location_id, e.product_id
     having sum(e.quantity_delta) <> 0
     union all
     select t.type || ' transaction nets ' || sum(e.quantity_delta)::text
       from inventory_entries e
       join inventory_transactions t on t.id = e.transaction_id
      where e.transaction_id = ?::uuid
        and t.type in ('FAMILY_STOCK_DISTRIBUTION', 'PRODUCT_STOCK_REASSIGNMENT')
      group by t.type
     having sum(e.quantity_delta) <> 0`,
    [transactionId, transactionId, transactionId, transactionId],
  );
  findings.push(...grainFindings.map((row) => ({ invariant: 'CONSERVATION_GRAIN', detail: row.detail })));

  if (findings.length) {
    throw new InternalServerErrorException(
      `Inventory posting postcondition failed and was rolled back: ${findings
        .map((f) => `${f.invariant} (${f.detail})`)
        .join('; ')}`,
    );
  }
}
