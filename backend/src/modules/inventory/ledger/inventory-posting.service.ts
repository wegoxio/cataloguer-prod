import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { InventoryTransaction } from '../entities/inventory-transaction.entity';
import {
  InventoryCommand,
  InventoryMovementLine,
  PostedTransaction,
  TRANSACTION_TYPE_RULES,
  POSTING_GUARD_SETTING,
} from './inventory.types';
import { commandFingerprint, movementKey, sortMovements } from './inventory-command-fingerprint';
import { assertPostingPostcondition } from './inventory-reconciliation.service';

/**
 * P5-B1 — the ONLY path that writes the inventory ledger and its projections
 * (ADR 013 §1).
 *
 * B1 boundary: nothing production calls this yet. The legacy writers W1–W10
 * still own `products.stock_quantity` and `store_products.stock_quantity`
 * untouched; converting them is B3. This service exists, is proved, and waits.
 *
 * It does not create locations and it does not post opening balances — B2 owns
 * both, inside the approved and fingerprinted opening process.
 */
@Injectable()
export class InventoryPostingService {
  constructor(
    @InjectRepository(InventoryTransaction)
    private readonly transactionRepository: EntityRepository<InventoryTransaction>,
  ) {}

  private get em(): EntityManager {
    return this.transactionRepository.getEntityManager() as EntityManager;
  }

  /**
   * Posts one command, exactly once.
   *
   * LOCK ORDER, fixed so deadlock is structurally impossible:
   *   1. an advisory lock on (organization, idempotency key);
   *   2. an advisory lock on the organization, for commands that touch
   *      organization-wide invariants;
   *   3. projection rows, taken in the CANONICAL movement order — the same
   *      order the fingerprint sorts by, so two concurrent postings over
   *      overlapping cells always acquire them in the same sequence.
   */
  async post(command: InventoryCommand): Promise<PostedTransaction> {
    return this.em.transactional(async (tem) => this.postWithin(tem as EntityManager, command));
  }

  /**
   * Posts inside a transaction the CALLER already opened.
   *
   * B3 needs this: a sale, its ledger posting, the postcondition and the
   * compatibility caches must commit together or roll back together, and that
   * is only true if they share one transaction. `post()` is this method with a
   * transaction wrapped around it, so there is one implementation and not two
   * that can drift.
   */
  async postWithin(em: EntityManager, command: InventoryCommand): Promise<PostedTransaction> {
    this.assertCommandShape(command);
    // BEFORE the advisory lock, the replay lookup and every write. A replay
    // arriving during a cutover window is an anomaly, not a convenience: the
    // window exists precisely because no ordinary caller should be posting,
    // so a frozen organization refuses replays too rather than quietly
    // returning a transaction id that implies the window was open.
    await this.assertCutoverFreeze(em, command);
    const fingerprint = commandFingerprint(command);

    {
      // em.execute, never getConnection().execute: the lock must join THIS
      // transaction and be released with it.
      await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `${command.organizationId}:${command.idempotencyKey}`,
      ]);

      const existing = await this.findExisting(em, command);
      if (existing) {
        if (existing.command_fingerprint !== fingerprint) {
          // A different payload under a live key is a conflict, never a replay.
          // Nothing has been written, so the rollback leaves no trace.
          throw new ConflictException('This idempotency key was already used for a different inventory command');
        }
        return {
          transactionId: existing.id,
          organizationId: command.organizationId,
          type: command.type,
          commandFingerprint: fingerprint,
          replayed: true,
        };
      }

      // Everything below writes. The guard flag is transaction-local (the third
      // argument), so it cannot leak into another statement or session.
      await em.execute('select set_config(?, ?, true)', [POSTING_GUARD_SETTING, 'on']);

      await this.assertTenancy(em, command);
      await this.assertDefaultWarehouse(em, command.organizationId);

      const transactionId = await this.insertTransaction(em, command, fingerprint);
      if (!transactionId) {
        // Another poster won the same key between our lookup and our insert.
        // Re-read under the same lock and settle it as replay or conflict.
        const winner = await this.findExisting(em, command);
        if (!winner) throw new ConflictException('Concurrent inventory posting could not be resolved');
        if (winner.command_fingerprint !== fingerprint) {
          throw new ConflictException('This idempotency key was already used for a different inventory command');
        }
        return {
          transactionId: winner.id,
          organizationId: command.organizationId,
          type: command.type,
          commandFingerprint: fingerprint,
          replayed: true,
        };
      }

      await this.insertIntents(em, command, transactionId);
      await this.insertEntries(em, command, transactionId);
      await this.applyProjections(em, command);

      // The atomic postcondition. It runs on `em` — the manager this transaction
      // callback received — so it reads the rows just written and still
      // uncommitted. A repository's manager would query outside the transaction
      // and see none of them. Any failure throws, and the whole posting
      // (transaction, intents, entries, projections) rolls back together.
      // The compatibility caches are refreshed from the ledger BEFORE the
      // postcondition, inside the same transaction, so a posting that fails its
      // own check takes the caches back with it.
      await this.syncCompatibilityCaches(
        em,
        command.organizationId,
        command.movements.map((line) => line.productId),
      );

      await assertPostingPostcondition(em, {
        organizationId: command.organizationId,
        transactionId,
      });

      return {
        transactionId,
        organizationId: command.organizationId,
        type: command.type,
        commandFingerprint: fingerprint,
        replayed: false,
      };
    }
  }

  /**
   * THE ONLY MECHANISM THAT WRITES THE LEGACY STOCK COLUMNS.
   *
   * `products.stock_quantity` and `store_products.stock_quantity` stop being
   * independently mutable state in B3 and become caches DERIVED from the
   * ledger: the product column is the organization's owned total (equation 10),
   * the pivot column is what that branch holds (equation 11). Nothing adds to
   * them or subtracts from them — they are recomputed, so they cannot drift by
   * an increment somebody forgot.
   *
   * Retiring the columns is a later, destructive boundary; until then this is
   * what keeps every existing reader correct.
   *
   * PUBLIC, because the opening epoch's zero-total branch needs the same
   * refresh: a product opened at ZERO whose legacy cache was non-zero would
   * otherwise fail LEGACY_PRODUCT_CACHE_EQUALITY forever, and unfreeze with it.
   * It reuses THIS mechanism rather than acquiring its own arithmetic — the
   * B3 writer census pins, by name, that this stays the only writer.
   */
  async syncCompatibilityCaches(em: EntityManager, organizationId: string, productIds: string[]): Promise<void> {
    for (const productId of [...new Set(productIds)]) {
      await em.execute(
        // #292: the cache is refreshed for the row it belongs to, WHATEVER its
        // lifecycle state. A removed item keeps a truthful cached total — its
        // ledger is retained, and a stale cache would make a restored item
        // reappear with the wrong number. Removal itself is blocked while any
        // balance is non-zero, so this can only run for a removed row when the
        // balances have already been cleared to zero.
        `update products p set stock_quantity = coalesce(( /* removed_at: the cache belongs to the row in any state */
             select sum(b.quantity) from inventory_balances b
              where b.organization_id = p.organization_id and b.product_id = p.id
           ), 0) + coalesce((
             select sum(t.quantity) from inventory_transit_balances t
              where t.organization_id = p.organization_id and t.product_id = p.id
           ), 0)
          where p.id = ?::uuid and p.organization_id = ?`,
        [productId, organizationId],
      );
      await em.execute(
        `update store_products sp set stock_quantity = coalesce((
             select sum(b.quantity)
               from inventory_balances b
               join inventory_locations l on l.id = b.location_id
              where b.organization_id = sp.organization_id and b.product_id = sp.product_id
                and l.kind = 'STORE' and l.store_id = sp.store_id
           ), 0)
          where sp.product_id = ?::uuid and sp.organization_id = ?`,
        [productId, organizationId],
      );
    }
  }

  // ── shape and conservation ────────────────────────────────────────────────

  /**
   * Conservation is checked PER PRODUCT against its own declared intent, and the
   * transaction-wide net is an ADDITIONAL assertion — never the only one. A
   * transaction-level `SUM(quantity_delta) = 0` on its own accepts "remove five
   * units of product A, add five of product B", which is stock teleporting
   * between products under the cover of a balanced total.
   */
  private assertCommandShape(command: InventoryCommand): void {
    const rule = TRANSACTION_TYPE_RULES[command.type];
    if (!rule) throw new BadRequestException(`Unknown inventory transaction type ${command.type}`);
    if (!command.idempotencyKey) throw new BadRequestException('An inventory command needs an idempotency key');
    // Provenance is part of the command, not decoration: without it one actor
    // could submit another's key and be handed their transaction as a replay.
    const principal = command.principal;
    if (!principal || (principal.kind !== 'USER' && principal.kind !== 'SYSTEM')) {
      throw new BadRequestException('An inventory command needs a USER or SYSTEM principal');
    }
    if (principal.kind === 'USER' && !principal.userId) {
      throw new BadRequestException('A USER principal needs a stable user id');
    }
    if (principal.kind === 'SYSTEM') {
      if (!principal.origin) throw new BadRequestException('A SYSTEM principal needs a stable origin');
      if ((principal as any).userId) {
        throw new BadRequestException('A SYSTEM principal must not carry a user id');
      }
    }
    if (command.movements.length === 0) throw new BadRequestException('An inventory command needs movement lines');
    if (command.intents.length === 0) throw new BadRequestException('An inventory command needs intent lines');

    for (const line of command.movements) {
      if (!Number.isInteger(line.quantityDelta) || line.quantityDelta === 0) {
        throw new BadRequestException('Every movement line needs a non-zero integer quantity');
      }
      const transit = line.operationalState === 'IN_TRANSIT';
      if (transit !== (line.locationId === null || line.locationId === undefined)) {
        throw new BadRequestException('IN_TRANSIT lines carry no location; located lines must carry one');
      }
      if (transit !== Boolean(line.transferId) || transit !== Boolean(line.transitDirection)) {
        throw new BadRequestException('IN_TRANSIT lines must name their transfer and direction, and only they may');
      }
    }
    for (const intent of command.intents) {
      if (!Number.isInteger(intent.declaredAmount) || intent.declaredAmount <= 0) {
        throw new BadRequestException('Declared amounts are positive integers; direction lives in the sign');
      }
      if (!rule.signs.includes(intent.intentSign)) {
        throw new BadRequestException(`${command.type} does not admit intent sign ${intent.intentSign}`);
      }
    }
    if (rule.exactIntentLines && command.intents.length !== rule.exactIntentLines) {
      throw new BadRequestException(`${command.type} requires exactly ${rule.exactIntentLines} intent lines`);
    }
    if (rule.minIntentLines && command.intents.length < rule.minIntentLines) {
      throw new BadRequestException(`${command.type} requires at least ${rule.minIntentLines} intent lines`);
    }
    if (rule.requiresScopeProduct && !command.scopeProductId) {
      throw new BadRequestException(`${command.type} must name the product scope it moves stock within`);
    }

    const intentByProduct = new Map<string, { amount: number; sign: number }>();
    for (const intent of command.intents) {
      if (intentByProduct.has(intent.productId)) {
        throw new BadRequestException('One intent line per product');
      }
      intentByProduct.set(intent.productId, { amount: intent.declaredAmount, sign: intent.intentSign });
    }

    // The intent set and the entry product set must be identical in both
    // directions: no undeclared product may move, and no declaration may be
    // left unfulfilled.
    const movementProducts = new Set(command.movements.map((line) => line.productId));
    for (const productId of movementProducts) {
      if (!intentByProduct.has(productId)) {
        throw new BadRequestException(`Product ${productId} moves without a declared intent`);
      }
    }
    for (const productId of intentByProduct.keys()) {
      if (!movementProducts.has(productId)) {
        throw new BadRequestException(`Product ${productId} declares intent but moves nothing`);
      }
    }

    for (const [productId, intent] of intentByProduct) {
      const lines = command.movements.filter((line) => line.productId === productId);
      const net = lines.reduce((sum, line) => sum + line.quantityDelta, 0);
      const gross = lines.filter((line) => line.quantityDelta > 0).reduce((sum, line) => sum + line.quantityDelta, 0);
      const drawn = lines.filter((line) => line.quantityDelta < 0).reduce((sum, line) => sum + line.quantityDelta, 0);

      if (intent.sign === 0) {
        // In place: the product nets to zero AND the gross movement equals the
        // declared amount. Net-zero alone would not say HOW MUCH moved, so a
        // command could claim to move 5 units and actually move 500.
        if (net !== 0) throw new BadRequestException(`Product ${productId} must net to zero for ${command.type}`);
        if (gross !== intent.amount || drawn !== -intent.amount) {
          throw new BadRequestException(`Product ${productId} moved ${gross} units but declared ${intent.amount}`);
        }
      } else if (net !== intent.sign * intent.amount) {
        throw new BadRequestException(
          `Product ${productId} changed by ${net} but declared ${intent.sign * intent.amount}`,
        );
      }
    }

    if (rule.mode === 'IN_PLACE') {
      // ONE composite key, not one pass per grain.
      //
      // Checking each grain separately proves only the MARGINALS of the
      // movement matrix. A 2x2 cross-swap satisfies both and still moves
      // quantity between forbidden cells: -5 at (L1, GOOD), -5 at (L2,
      // DAMAGED), +5 at (L1, DAMAGED), +5 at (L2, GOOD). Every location nets
      // zero. Every condition nets zero. Five units nevertheless changed both
      // their location and their condition, which is exactly what an in-place
      // type forbids. The composite key sees the cells themselves.
      const buckets = new Map<string, number>();
      for (const line of command.movements) {
        const parts = [line.productId];
        for (const grain of rule.grain) {
          parts.push(grain === 'location' ? (line.locationId ?? 'transit') : line.physicalCondition);
        }
        buckets.set(parts.join('|'), (buckets.get(parts.join('|')) ?? 0) + line.quantityDelta);
      }
      for (const [key, net] of buckets) {
        if (net !== 0) {
          throw new BadRequestException(
            `${command.type} must conserve per (product, ${rule.grain.join(', ')}); ${key} nets ${net}`,
          );
        }
      }
    }

    if (rule.mode === 'CROSS_PRODUCT') {
      // The quantity legitimately changes product, so per-product nets are
      // non-zero by design — but the transaction as a whole must still conserve,
      // and the declared intents must themselves balance.
      const declaredNet = command.intents.reduce((sum, intent) => sum + intent.intentSign * intent.declaredAmount, 0);
      const movedNet = command.movements.reduce((sum, line) => sum + line.quantityDelta, 0);
      if (declaredNet !== 0 || movedNet !== 0) {
        throw new BadRequestException(`${command.type} must conserve across the whole transaction`);
      }
      const sources = command.intents.filter((intent) => intent.intentSign === -1);
      const destinations = command.intents.filter((intent) => intent.intentSign === 1);
      if (sources.length !== 1) {
        throw new BadRequestException(`${command.type} needs exactly one declared source product`);
      }
      if (destinations.length === 0) {
        throw new BadRequestException(`${command.type} needs a declared destination product`);
      }
      // The source is always the NAMED SCOPE PRODUCT: the scope is what the
      // stock leaves. Letting them differ would let a command name one product
      // for authorisation and drain another.
      if (sources[0].productId !== command.scopeProductId) {
        throw new BadRequestException(
          `${command.type} must draw from the named scope product, not ${sources[0].productId}`,
        );
      }
      if (destinations.some((intent) => intent.productId === sources[0].productId)) {
        throw new BadRequestException(`${command.type} cannot move stock from a product to itself`);
      }
      if (rule.crossProductRule === 'GENERAL') {
        // R12 generalized case: one source, one destination, equal amounts. The
        // destination is NOT constrained by family — any product of the acting
        // organization is legitimate.
        if (destinations.length !== 1) {
          throw new BadRequestException(`${command.type} names exactly one destination product`);
        }
        if (destinations[0].declaredAmount !== sources[0].declaredAmount) {
          throw new BadRequestException(`${command.type} must declare equal source and destination amounts`);
        }
      }
    }
  }

  // ── tenancy ───────────────────────────────────────────────────────────────

  private async assertTenancy(em: EntityManager, command: InventoryCommand): Promise<void> {
    const productIds = [
      ...new Set([
        ...command.movements.map((line) => line.productId),
        ...command.intents.map((line) => line.productId),
        ...(command.scopeProductId ? [command.scopeProductId] : []),
      ]),
    ];
    // Placeholders are expanded explicitly: the query builder binds a JS array
    // as one literal, so `= any(?::uuid[])` reaches PostgreSQL as a malformed
    // array value rather than a list.
    const products: { id: string }[] = await em.execute(
      // #292: an inventory command may not name a removed item. Excluding it
      // here turns the attempt into the existing "must belong to the acting
      // organization" refusal rather than a posting against an invisible row.
      // The trigger in Migration20260911130000 is the backstop for the race.
      `select id from products
        where id in (${productIds.map(() => '?::uuid').join(', ')}) and organization_id = ? and removed_at is null`,
      [...productIds, command.organizationId],
    );
    if (products.length !== productIds.length) {
      throw new BadRequestException('Every product in an inventory command must belong to the acting organization');
    }

    const locationIds = [
      ...new Set(command.movements.map((line) => line.locationId).filter((id): id is string => Boolean(id))),
    ];
    if (locationIds.length) {
      const locations: { id: string }[] = await em.execute(
        `select id from inventory_locations where id in (${locationIds.map(() => '?::uuid').join(', ')}) and organization_id = ?`,
        [...locationIds, command.organizationId],
      );
      if (locations.length !== locationIds.length) {
        throw new BadRequestException('Every location in an inventory command must belong to the acting organization');
      }
    }

    // R12 splits the two product-changing commands, and so does this check.
    if (TRANSACTION_TYPE_RULES[command.type].crossProductRule === 'FAMILY') {
      // The CONSTRAINED case. The source is the family root (already asserted to
      // equal the scope product) and every destination must be a LEGITIMATE
      // CHILD of that root — not a sibling, not the root itself, not an
      // unrelated product. Child-to-root and sibling-to-sibling are refused
      // here on purpose: those are reassignments, and reassignment is the other
      // command.
      const children: { id: string }[] = await em.execute(
        // #292: a removed child is not part of the family for command scoping.
        'select id from products where organization_id = ? and parent_id = ?::uuid and removed_at is null',
        [command.organizationId, command.scopeProductId],
      );
      const childIds = new Set(children.map((row) => row.id));
      for (const intent of command.intents) {
        if (intent.intentSign === -1) continue; // the root itself, already proved
        if (!childIds.has(intent.productId)) {
          throw new BadRequestException(
            `${command.type} may only distribute to children of ${command.scopeProductId}; ` +
              `${intent.productId} is not one`,
          );
        }
      }
    }
    // GENERAL needs no further scope query: both products were proved to belong
    // to the acting organization by the product check above, and that IS the
    // whole of the R12 generalized constraint.

    // `sales_order_id` carries no foreign key because
    // table has `(id, organization_id)` unique and `sales_orders.organization_id`
    // is still nullable, so a tenant-safe composite reference is impossible
    // today and a single-column one would be organization-blind. Their tenancy
    // is asserted here instead, and the schema work that would let the database
    // hold it is recorded in the boundary notes.
    if (command.salesOrderId) {
      const rows: { n: number }[] = await em.execute(
        `select count(*)::int as n from sales_orders o join stores s on s.id = o.store_id
          where o.id = ?::uuid and s.organization_id = ?
          /* removed_at: DELIBERATELY UNFILTERED. This asks one question — does
             this order belong to the acting company? — and its refusal says so.
             Narrowing it to live branches would answer "not in your
             organization" about an order that plainly is, which is a false
             statement rather than a stricter one. The lifecycle refusal is a
             different rule and is enforced where it belongs: the database
             refuses any inventory row at a removed store's location, so this
             path cannot post into one whatever this count says. */`,
        [command.salesOrderId, command.organizationId],
      );
      if (!rows[0] || rows[0].n !== 1) {
        throw new BadRequestException('The referenced sales order is not in the acting organization');
      }
    }
  }

  /**
   * The existence half of "exactly one default warehouse per organization".
   * The partial unique index enforces AT MOST one; only an assertion can
   * require that one exists, so both halves are stated and neither is claimed
   * to do the other's job.
   */
  private async assertDefaultWarehouse(em: EntityManager, organizationId: string): Promise<void> {
    const rows: { n: number }[] = await em.execute(
      "select count(*)::int as n from inventory_locations where organization_id = ? and is_default and kind = 'WAREHOUSE'",
      [organizationId],
    );
    if (!rows[0] || rows[0].n !== 1) {
      throw new BadRequestException('This organization has no default warehouse; inventory cannot be posted');
    }
  }

  /**
   * P5-X1 — the organization cutover freeze, enforced ONCE, here.
   *
   * This is the whole enforcement surface, and it can be because P5-B3 left
   * exactly one way to change inventory: every sale, cancellation, receipt,
   * bulk edit, import, reservation, transfer and adjustment reaches the ledger
   * through `postWithin`, and `inventory-writer-census.spec.ts` asserts that no
   * second construct writes a legacy stock column. Scattering the same check
   * across controllers would cover fewer callers, not more — an indirect or
   * background caller never passes a controller, but it cannot avoid this.
   *
   * The rule is symmetrical, and both halves fail closed:
   *
   *   frozen + OPENING_BALANCE ....... allowed — the epoch is why we froze
   *   frozen + anything else ......... refused
   *   unfrozen + OPENING_BALANCE ..... REFUSED — an epoch outside a declared
   *                                    window would be exactly the concurrent
   *                                    legacy-writer race the freeze prevents
   *   unfrozen + anything else ....... allowed — ordinary operation
   *   organization absent ............ refused, rather than read as unfrozen
   */
  private async assertCutoverFreeze(em: EntityManager, command: InventoryCommand): Promise<void> {
    const rows: { frozen: boolean }[] = await em.execute(
      `select ("inventory_cutover_frozen_at" is not null) as frozen from organizations where id = ?
       /* removed_at: the freeze probe reads in every state; the lifecycle guard refuses the posting itself (#294) */`,
      [command.organizationId],
    );
    if (!rows[0]) {
      // Never infer "unfrozen" from a missing row. `assertTenancy` would also
      // refuse this command, but it runs later and this must not depend on it.
      throw new BadRequestException('This organization does not exist; inventory cannot be posted');
    }
    const frozen = rows[0].frozen === true;

    if (command.type === 'OPENING_BALANCE') {
      if (!frozen) {
        throw new ConflictException('An opening epoch may only post while the organization is frozen for cutover');
      }
      return;
    }
    if (frozen) {
      throw new ConflictException(
        'This organization is frozen for the inventory cutover; ordinary inventory postings are refused',
      );
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  private async findExisting(
    em: EntityManager,
    command: InventoryCommand,
  ): Promise<{ id: string; command_fingerprint: string } | null> {
    const rows: { id: string; command_fingerprint: string }[] = await em.execute(
      'select id, command_fingerprint from inventory_transactions where organization_id = ? and idempotency_key = ?',
      [command.organizationId, command.idempotencyKey],
    );
    return rows[0] ?? null;
  }

  private async insertTransaction(
    em: EntityManager,
    command: InventoryCommand,
    fingerprint: string,
  ): Promise<string | null> {
    // P5-C2B: through the definer function, never a direct INSERT. The runtime
    // role holds SELECT on this table and nothing else, so this call is the
    // only way a row can appear — and the function's fixed argument list is
    // what makes it a door rather than a hole. The statement inside it is this
    // exact insert, conflict clause and all.
    const rows: { id: string | null }[] = await em.execute(
      `select inventory_definer_insert_transaction(
         ?::uuid, ?, ?, ?, ?::uuid, ?::uuid, ?, ?::uuid, ?, ?, ?::uuid, ?::uuid
       ) as id`,
      [
        command.organizationId,
        command.type,
        command.idempotencyKey,
        fingerprint,
        command.scopeProductId ?? null,
        command.auditStoreId ?? null,
        command.principal.kind,
        command.principal.kind === 'USER' ? command.principal.userId : null,
        command.principal.kind === 'USER' ? (command.principal.email ?? null) : null,
        command.principal.kind === 'SYSTEM' ? command.principal.origin : null,
        command.salesOrderId ?? null,
        command.transferId ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  }

  private async insertIntents(em: EntityManager, command: InventoryCommand, transactionId: string): Promise<void> {
    for (const intent of command.intents) {
      await em.execute(`select inventory_definer_insert_intent(?::uuid, ?::uuid, ?::uuid, ?::integer, ?::smallint)`, [
        transactionId,
        command.organizationId,
        intent.productId,
        intent.declaredAmount,
        intent.intentSign,
      ]);
    }
  }

  private async insertEntries(em: EntityManager, command: InventoryCommand, transactionId: string): Promise<void> {
    for (const line of sortMovements(command.movements)) {
      await em.execute(
        `select inventory_definer_insert_entry(
           ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?::uuid, ?, ?::integer
         )`,
        [
          transactionId,
          command.organizationId,
          line.productId,
          line.locationId ?? null,
          line.physicalCondition,
          line.operationalState,
          line.transferId ?? null,
          line.transitDirection ?? null,
          line.quantityDelta,
        ],
      );
    }
  }

  /**
   * Applies the movement lines to the projections.
   *
   * Cells are aggregated first, then written in CANONICAL ORDER — the same sort
   * the fingerprint uses. Two concurrent postings touching overlapping cells
   * therefore take their row locks in the same sequence, which is what keeps
   * them from deadlocking.
   *
   * `CHECK (quantity >= 0)` is what refuses an over-draw. The application does
   * not decide whether enough stock exists; the database does, holding the row.
   *
   * Each cell is applied in TWO statements, and not as `INSERT ... ON CONFLICT
   * DO UPDATE`, because PostgreSQL evaluates a CHECK against the PROPOSED
   * insert row BEFORE it resolves the conflict: a legitimate `-3` against a
   * cell holding 10 would be refused for the candidate row's own sake, never
   * reaching the update that would have left 7. Proved in isolation while
   * building this boundary. So: ensure the cell exists at zero, which always
   * satisfies the CHECK, then add the delta with an UPDATE that takes the row
   * lock and lets the constraint judge the FINAL value.
   *
   * P5-C2B moved that pair INSIDE the definer function rather than dropping
   * it: the two statements are still two statements, and they now run where
   * the runtime role's lack of DML cannot reach them. One call per cell, so
   * half a protected write can never happen outside the door.
   */
  private async applyProjections(em: EntityManager, command: InventoryCommand): Promise<void> {
    const cells = new Map<string, InventoryMovementLine>();
    for (const line of command.movements) {
      const key = movementKey(line);
      const seen = cells.get(key);
      if (seen) seen.quantityDelta += line.quantityDelta;
      else cells.set(key, { ...line });
    }

    for (const line of sortMovements([...cells.values()])) {
      if (line.quantityDelta === 0) continue;
      if (line.operationalState === 'IN_TRANSIT') {
        const transitKey = [
          command.organizationId,
          line.transferId,
          line.transitDirection,
          line.productId,
          line.physicalCondition,
        ];
        // ONE call, because the ensure-then-add pair is the function's body:
        // splitting it here would put half the protected write outside the door.
        await em.execute(
          `select inventory_definer_apply_transit_balance(?::uuid, ?::uuid, ?, ?::uuid, ?, ?::integer)`,
          [...transitKey, line.quantityDelta],
        );
      } else {
        const cellKey = [
          command.organizationId,
          line.locationId,
          line.productId,
          line.physicalCondition,
          line.operationalState,
        ];
        await em.execute(`select inventory_definer_apply_balance(?::uuid, ?::uuid, ?::uuid, ?, ?, ?::integer)`, [
          ...cellKey,
          line.quantityDelta,
        ]);
      }
    }
  }
}
