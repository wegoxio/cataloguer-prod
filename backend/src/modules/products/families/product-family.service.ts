import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { Product } from '../entities/product.entity';
import { StoreProduct } from '../entities/store-product.entity';
import { storeIdOf } from '../shared/store-membership.util';
import {
  assertBranchesKeepLiveChildVisible,
  assertEligibleAsChild,
  assertLabelFree,
  assertParentCanHostLiveChild,
} from './family-membership';
import { Store } from '../../stores/entities/store.entity';
import { ProductStatus } from '../catalogue/product-status.enum';
import { AddFamilyMemberDto, UpdateFamilyMemberDto } from '../dto/family-member.dto';
import { FamilyDissolveResult, FamilyMutationResult } from './family.types';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Action, EntityType } from '../../audit-log/entities/audit-log.entity';
import { Actor } from '../../audit-log/types/actor.type';
import { AuditContext } from '../../audit-log/types/audit-context.type';
import {
  LockSetWidenedError,
  PublicationGuardService,
  RowLockUnavailableError,
  isLockNotAvailable,
} from '../publication/publication-guard.service';
import { storePublicationLock } from './advisory-lock.util';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

/**
 * The branch the caller is working in, or null when it speaks for the whole
 * company. P5-A2 canonical family 7: this replaces `actor.store`, which named
 * the person's binding rather than the branch in context and said nothing at
 * all for a store-less organization manager.
 */
const narrowedOf = (scope?: TenantScope): string | null =>
  typeof scope?.storeId === 'string' && scope.storeId.length > 0 ? scope.storeId : null;

/**
 * Management of a product family after it exists: attach or release child
 * products, rename what the selector shows, or dissolve the family back into
 * standalone products. Creation lives in ProductsService.createFamily.
 *
 * Every rule mirrors what the hierarchy means: a child belongs to exactly one
 * parent, a parent cannot itself be a child, and two children of one parent
 * cannot present the same label — the selector could not tell them apart.
 *
 * Shape transitions run under the family locks (B4a3), one fresh retryable
 * transaction per attempt. Attaching serializes only — it can only take the
 * card's sellability away. RELEASING can grant it: a card whose last child
 * leaves becomes sellable, so the release validates the card's published
 * exposure — after the shape change is applied, because sellability belongs
 * to the shape as committed — and a refusal rolls the whole release back.
 */
@Injectable()
export class ProductFamilyService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
    private readonly auditLogService: AuditLogService,
    private readonly publicationGuard: PublicationGuardService,
  ) {}

  async addMember(
    parentId: string,
    dto: AddFamilyMemberDto,
    actor: Actor,
    scope?: TenantScope,
  ): Promise<FamilyMutationResult> {
    const em = this.productRepository.getEntityManager();
    /*
     * A ROW LOCK REFUSED ENDS THE ATTEMPT, AND THE NEXT ONE WAITS FIRST.
     *
     * `lockedFamilyVisibility` takes the card's row and the pivots with
     * `NOWAIT` while it holds the member's row for update (see there). A
     * refusal means somebody holds one of those rows; the attempt is rolled
     * back whole — every key and every row lock released — and before the
     * next attempt this waits for the busy rows, ONE ROW PER TRANSACTION, so
     * that no wait holds another row while it waits (see `waitForRows`). Then the
     * attempt starts again. Its ROWS it reads afresh; its entities it may
     * get back from the request's manager as the last attempt left them, and
     * the rules therefore decide from rows read under the locks (see
     * `attach`). `withLockRetry` bounds the attempts, as it does for a
     * widening.
     */
    let busy: RowLockUnavailableError['rows'] | null = null;
    const result = await this.publicationGuard.withLockRetry(async () => {
      if (busy) {
        await this.waitForRows(em, busy);
        busy = null;
      }
      try {
        // Each attempt reads its rows again; what it must not trust is the
        // entity graph, which the request's manager keeps across attempts.
        return await this.attach(em, parentId, dto, scope);
      } catch (err) {
        if (err instanceof RowLockUnavailableError) busy = err.rows;
        throw err;
      }
    });

    await this.audit(
      actor,
      result.parent.id,
      Action.UPDATE,
      `Added "${result.member.name}" to parent "${result.parent.name}" as "${result.member.label}"`,
      { organizationId: result.organizationId },
    );
    return { parentId: result.parent.id, member: result.member };
  }

  /** One attempt of `addMember`: one transaction, from the loads to the reconciliation. */
  private attach(
    em: EntityManager,
    parentId: string,
    dto: AddFamilyMemberDto,
    scope?: TenantScope,
  ): Promise<{
    parent: { id: string; name: string };
    member: ReturnType<ProductFamilyService['toMember']>;
    organizationId: string | null;
  }> {
    return em.transactional(async (tem) => {
      const parent = await this.loadParent(tem, parentId, narrowedOf(scope));
      const member = await tem.findOne(
        Product,
        { id: dto.productId, ...(narrowedOf(scope) ? { stores: narrowedOf(scope) } : {}) },
        // `stores` is populated for the shared eligibility guard, which
        // refuses a product belonging to no store — a rule this path did not
        // have and the creation path did.
        { populate: ['children', 'stores'] },
      );
      if (!member) throw new NotFoundException(`Item ${dto.productId} not found`);
      // Re-hydrated from its row, because this may be the second attempt:
      // `em.transactional` forks the request's manager without clearing it,
      // and an attempt rolled back AFTER its write leaves `parent` set on the
      // instance the controller loaded. Read from the identity map, that
      // instance made the next attempt refuse its own member as "already a
      // child". (`refresh: true` on the load above trips the ORM's pivot
      // loader; this reloads the row's own columns and leaves the
      // collections as populated.)
      if (!(await tem.refresh(member))) throw new NotFoundException(`Item ${dto.productId} not found`);
      if (member.id === parent.id) throw new BadRequestException('A product cannot be its own parent');
      // The SAME rules the creation endpoint applies, from one place.
      assertEligibleAsChild(member);
      const parentOrganizationId = this.organizationIdOf(parent);
      if (this.organizationIdOf(member) !== parentOrganizationId) {
        // Same 404-shape as a missing id: foreign catalogues are invisible
        throw new NotFoundException(`Item ${dto.productId} not found`);
      }

      /*
       * Serialization only: attaching exposes nothing — it can only make the
       * card UNsellable. Lock the destination root and the member's own
       * root. A root that has moved since the two were loaded is refused
       * below, not restarted. What can still widen between the two readings
       * is the set of store keys — the member is given a branch — and a
       * widening restarts the whole attempt.
       *
       * AND THE BRANCHES THE CARD IS ABOUT TO GAIN. `reconcileStoresOfParent`
       * runs below, in this transaction and therefore under the family keys
       * taken here, and needs a store key for every branch the card gains —
       * which for an attachment is the ORDINARY case, since giving the card
       * the newcomer's branches is the whole reason that call exists. Left
       * to acquire what it needed, it took those keys there: a namespace-1
       * key taken while a namespace-2 key is held is the one order this
       * codebase forbids — another writer takes them the other way round and
       * the two deadlock, PostgreSQL aborting one — and `withLockRetry` did
       * not rescue it, so an ordinary attachment surfaced as a 500. The
       * store keys are therefore named HERE, and the reconciliation is told
       * the keys this named and acquires none (see the call below).
       *
       * Named from the guard's own `storesToGain`, which applies the rule
       * the reconciliation applies — every branch a child is in, less the
       * branches the card is in — in a read of its own. The reconciliation
       * derives separately; what matters here is that `storesToGain` never
       * names fewer stores than the card will gain — a shortfall now costs a
       * restart after the write, not a key taken late.
       * The member's branches are passed explicitly because it is not a child
       * yet, so the family cannot be read for them. `acquire` sorts namespace
       * 1 ahead of namespace 2. The reconciliation asks for nothing: a branch
       * it would gain beyond the keys it is handed is refused, and the
       * attempt starts again naming it.
       *
       * THE BRANCH ASSIGNMENT NO LONGER OPENS A WINDOW HERE. A
       * `PUT /products/:memberId/stores/:storeId` whose body published
       * nothing used to take no advisory key at all — an empty
       * `validationStoreIds` made `exposureLockKeys` return none, not even a
       * family key — so it could create the member a pivot between the
       * second derivation's read and the reconciliation, and the card gained
       * a branch this attachment never named. Since #333 that endpoint takes
       * its product's family key on every body, and so does every membership
       * edit behind the API, before it writes: they wait for this
       * transaction, and start again from the row as it then stands.
       *
       * What is not closed is drift from a writer that holds no family key
       * for the product it gives a branch: the plan-based import runner, for
       * a product that is and stays a standalone. Drift landing before the
       * second derivation widens the key set and the attempt starts again;
       * later than that it does not.
       *
       * What this write VALIDATES is unchanged: attaching validates no
       * publication, and `withFamilyShapeLocks` leaves validation to its
       * caller either way. Locking a branch is not claiming to publish in it.
       *
       * THREE THINGS DECIDED BEFORE THE KEYS ARE DECIDED AGAIN HERE (#337).
       * The card and the member were loaded above, before any key was asked
       * for. That both are in the catalogue, that the card is not a child
       * and that the member is nobody's were decided from those two
       * entities. The derivation below read both rows again, on each pass,
       * but only to NAME its keys: nothing was refused for what they said.
       * Those three are now refused from the rows. What else was decided
       * above — the same company, the member in at least one branch, the
       * branch a caller is narrowed to — is not looked at again.
       *
       * IN THE CATALOGUE. This read goes through the removed filter, so a
       * product removed since it was loaded is absent from `rows`. The
       * attachment could then go on and write `parent_id` against a removed
       * card, or onto a removed member; #337 records the runs in which it
       * did and the ones in which it failed instead. An absence is refused,
       * with the answer a product that is not there gets.
       *
       * WITHOUT A LIVE PARENT. What became of a product given a parent since
       * it was loaded depended on when. Where the other attachment had
       * committed before the first reading here, the first pass named the
       * new root as a key and nothing objected: a member was moved to this
       * card, both attachments answering that they had succeeded, and a
       * card was refused only by a second attempt, after the first had
       * written. Where it committed between the two readings, the key set
       * widened, the attempt was rolled back having written nothing, and
       * the second attempt refused. Both are now refused from the row, on
       * the reading that first sees it, with the answer the checks above
       * give.
       *
       * "Live", because a parent is read through the removed filter, here
       * and above alike: a product whose parent has been removed reads as
       * having none, and is attached. That was so before this change, and
       * is not changed by it.
       *
       * On the second pass the read is made under the keys the first pass
       * named, which include the family key of each product as it stood.
       * Removal takes the family key of the product it removes before it
       * writes, and an attachment takes the family key of the product it
       * attaches. Those are the two writers this was run against
       * (`attach-liveness.pg.spec.ts`).
       *
       * Nothing is read for it that was not read already.
       */
      const named = await this.publicationGuard.withFamilyShapeLocks(tem, async () => {
        const rows = await tem.find(Product, { id: { $in: [parent.id, member.id] } }, { refresh: true });
        const card = rows.find((row) => row.id === parent.id);
        const joining = rows.find((row) => row.id === member.id);
        if (!card) throw new NotFoundException(`Item ${parent.id} not found`);
        if (!joining) throw new NotFoundException(`Item ${member.id} not found`);
        if (card.parent) {
          throw new BadRequestException('A child cannot have children; manage this from the parent product');
        }
        if (joining.parent) {
          throw new BadRequestException(`"${joining.name}" is already a child of another parent`);
        }
        // Re-read rather than using the populated collection: the protocol
        // derives twice, and a cached answer would repeat itself instead of
        // noticing a branch the member gained between the two passes.
        const memberLinks = await tem.find(StoreProduct, { product: member.id }, { refresh: true });
        const memberStoreIds = memberLinks.map(storeIdOf);
        // AND THE STORES THE MEMBER IS IN THAT THE COMPANY HAS REMOVED (#342).
        // Nothing above can see them. A restoration of one of them holds that
        // store's key while it works out which cards have a child there; this
        // attachment, running beside it, would give the card only the live
        // branches while the restoration found no card to follow, and both
        // would commit — the member published in a store its card is not in.
        // Named here, the two take turns. If a restoration commits between this
        // derivation and the acquisition of the keys, the store is live by the
        // time the card is reconciled below, and the card gains it under a key
        // that is held.
        const removedStoreIds = await this.publicationGuard.removedStoreIdsOf(tem, member.id);
        const gains = await this.publicationGuard.storesToGain(tem, parent.id, memberStoreIds);
        return {
          familyRootIds: rows.map((row) => PublicationGuardService.familyRootIdOf(row)),
          validationStoreIds: Array.from(new Set([...gains, ...removedStoreIds])),
          memberStoreIds,
        };
      });

      // Decided under the locks, where the shape is finally stable: the
      // member must still be childless, and the label must still be free.
      if ((await tem.count(Product, { parent: member.id })) > 0) {
        throw new BadRequestException(`"${member.name}" is a parent with children of its own`);
      }
      const siblings = await tem.find(Product, { parent: parent.id }, { refresh: true });
      this.assertLabelFree(siblings, dto.label);
      // Phase 2: joining a family changes what direct values are LEGAL —
      // a member carrying parent-only or override-forbidden specification
      // values, or a parent carrying child-only ones, refuses here.
      await this.publicationGuard.assertMembersAttachable(tem, [member.id], parent.id);

      // A child reaches a shopper ONLY through its parent's card, so the
      // card must be as visible as the child is — company-wide, and in every
      // branch the child is published in.
      const visibility = await this.lockedFamilyVisibility(tem, parent.id, member.id);

      /*
       * THE MEMBER'S BRANCHES, AS LOCKED, AGAINST THE ONES THE KEYS WERE NAMED
       * FROM. The member's row is held for update now, so its pivot ROWS
       * cannot change: an insert needs a key-share on that row, a delete needs
       * the pivot row, which is held for share. But the `FOR UPDATE` may have
       * WAITED for exactly such an insert — a pivot in a new branch, being
       * written by a writer that holds no family key, the runner for a
       * standalone — and the derivation above ran before it, so it did not
       * name that branch. Left to acquire what it needed, the reconciliation
       * then took that branch's store key after the family keys, after the
       * row locks and after the write: the one order this codebase forbids.
       * Now it would refuse the branch and start the attempt again — after
       * the write. So a locked branch that none of the sets the keys were
       * named from contains is a widened key set, raised HERE, before
       * anything is written; the attempt starts again and names it.
       *
       * The comparison is of branch SETS, not of keys: the member's branches
       * as the derivation read them, the card's as locked (a branch the card
       * is in is never gained), and the ones the derivation named to gain. A
       * branch the derivation read and did not name because the card was in
       * it is not looked at again: were the card's pivot there deleted between
       * the derivation and this read, the reconciliation would refuse that
       * branch and the attempt would start again after the write. The
       * writers that delete a card's pivot take the card's family key first,
       * which this has held since the derivation; a deletion beside this by a
       * writer that holds no key is not held against.
       *
       * Rows cannot change; the branch set can. Removing or restoring a store
       * is a write to ITS row, which this holds nothing on, and both reads
       * here see a store as it stands when they run. A branch removed after
       * the keys were named is no longer read here, and is not gained.
       *
       * A branch of the MEMBER that is restored while this runs needs nothing
       * here: the keys of the member's removed stores were named with the
       * rest (#342), so the restoration waits for this attachment, or this
       * for it, and where the store came back first the card simply gains it
       * below under a key that is held.
       *
       * A branch held by an EXISTING child and absent from the card's pivots,
       * restored after the keys were named, is not seen here — this reads only
       * the card's and the member's pivots — and its key was not named. The
       * reconciliation, which is handed the keys this derivation named (a
       * subset of what is held, see `familyShapeKeysOf`), refuses it, and the
       * attempt starts again naming it. Only a store brought back WITHOUT
       * `StoreRemovalService.restore` reaches this — `removed_at = null` by
       * hand, or a revision from before #342 still serving during a rollout:
       * a restoration through the service names the card's family key, so it
       * cannot commit between this attachment's keys and its reconciliation,
       * and one that commits before the keys widens the key set instead.
       *
       * Held: the runner's pivot in flight when the row lock is asked for, with
       * and without a branch assignment of a sibling arriving in that branch;
       * a store removed after the keys were named; a branch of the member
       * restored after the keys were named, before and after this read; a
       * branch of an existing child restored after the keys were named, with
       * and without the request's preloaded entities.
       */
      const cardBranches = new Set(visibility.cardBranches);
      const late = visibility.memberBranches.filter(
        (storeId) =>
          !named.memberStoreIds.includes(storeId) &&
          !cardBranches.has(storeId) &&
          !named.validationStoreIds.includes(storeId),
      );
      if (late.length > 0) throw new LockSetWidenedError(late.map(storePublicationLock));

      /*
       * THE RULES DECIDE FROM WHAT WAS LOCKED, NOT FROM WHAT WAS LOADED. The
       * `stores` collection `assertEligibleAsChild` looked at above was loaded
       * before any key — and, on a second attempt, by the previous attempt:
       * `em.transactional` forks the request's manager without clearing it, so
       * an attempt that was rolled back leaves its collections on the shared
       * entity, and the next attempt's load hands them back as they were. A
       * member that lost its last branch while this waited between attempts
       * still looked like a member with a branch. The branches read under the
       * locks are what decides.
       */
      if (visibility.memberBranches.length === 0) {
        throw new BadRequestException(`"${member.name}" belongs to no store, so it cannot become a child product`);
      }
      const liveMember = { id: member.id, name: member.name, ...visibility.member };
      assertParentCanHostLiveChild({ name: parent.name, ...visibility.parent }, liveMember);
      assertBranchesKeepLiveChildVisible({ name: parent.name }, liveMember, visibility.hiddenIn);

      member.parent = parent;
      member.optionLabel = dto.label.trim();
      await tem.flush();
      // The card's stores are the union of its children's, so a new child
      // widens it. Without this the card stayed unreachable in a store only
      // the newcomer serves — and children never list on their own.
      //
      // TOLD THE KEYS THIS NAMED, THE RECONCILIATION ACQUIRES NOTHING. Left to
      // acquire what it needs, it took a store key here — after the family
      // keys, the row locks and the write above — whenever its own derivation
      // found a branch the derivation above had not: a branch of the member
      // restored after the locked read, or a branch of an EXISTING child
      // restored after the keys were named, which the comparison above does
      // not look at. Handed the keys, it refuses such a branch as a widened
      // key set instead; the attempt is rolled back whole and the next names
      // it. A restart after the write, which is why the member is re-hydrated
      // with `tem.refresh` above.
      //
      // What is handed over is what the SECOND derivation named, which the
      // first — the one acquired from — is checked to contain: never more
      // than is held, possibly less. A branch that left between the two
      // derivations and came back before the reconciliation is then refused
      // although its key is held, and costs one restart it need not have.
      await this.publicationGuard.reconcileStoresOfParent(
        tem,
        parent.id,
        parentOrganizationId,
        this.publicationGuard.familyShapeKeysOf(named),
      );
      return {
        parent: { id: parent.id, name: parent.name },
        member: this.toMember(member),
        organizationId: this.organizationIdOf(parent),
      };
    });
  }

  /**
   * Waits for rows another transaction holds, ONE ROW PER TRANSACTION: each
   * wait is a transaction of its own with a single `FOR SHARE`, which blocks
   * until the holder commits or rolls back, and a commit that releases it at
   * once. It decides nothing, and no wait holds any row but the one it is
   * waiting for.
   *
   * ONE ROW, NOT ONE STATEMENT. This used to take every busy row in one
   * statement of one transaction. The rows are visited in whatever order the
   * plan visits them, so it could take the member's share and then wait for
   * the card's — and a writer that had written the card and went on to the
   * member waited on that share: `40P01`. An import batch that writes the
   * card and then the member is exactly that writer (held in
   * `import-lock-order.pg.spec.ts`, in the order that used to deadlock, for
   * the product rows and for the pivots).
   *
   * THE PIVOTS ARE THE ONES THE REFUSED READ ASKED FOR: the two products'
   * pivots in stores the company still has (`lockedFamilyVisibility`). They
   * are listed without a lock and then waited for one by one. A pivot that
   * appears after the list is not waited for; the next attempt asks again,
   * and `withLockRetry` bounds the attempts.
   *
   * The attempt that follows reads every row again for itself.
   */
  private async waitForRows(em: EntityManager, rows: RowLockUnavailableError['rows']): Promise<void> {
    let ids: string[] = rows.ids;
    if (rows.table === 'store_products') {
      const pivots = (await em.execute(
        `select sp.id
           from store_products sp
           join stores s on s.id = sp.store_id
          where sp.product_id in (?, ?)
            and s.removed_at is null
          order by sp.id`,
        rows.ids,
      )) as { id: string }[];
      ids = pivots.map((pivot) => pivot.id);
    }
    for (const id of ids) {
      await em.transactional(async (tem) => {
        if (rows.table === 'products') {
          await tem.find(Product, { id }, { lockMode: LockMode.PESSIMISTIC_READ, refresh: true });
        } else {
          await tem.execute(`select id from store_products where id = ? for share`, [id]);
        }
      });
    }
  }

  async updateMemberLabel(
    parentId: string,
    memberId: string,
    dto: UpdateFamilyMemberDto,
    actor: Actor,
    scope?: TenantScope,
  ): Promise<FamilyMutationResult> {
    // A rename changes no shape and no exposure — no locks, no transaction
    // beyond the flush, exactly as before.
    const em = this.productRepository.getEntityManager();
    const parent = await this.loadParent(em, parentId, narrowedOf(scope));
    const member = this.memberOf(parent, memberId);
    this.assertLabelFree(parent.children.getItems(), dto.label, member.id);

    const before = member.optionLabel ?? null;
    member.optionLabel = dto.label.trim();
    await em.flush();

    await this.audit(
      actor,
      parent.id,
      Action.UPDATE,
      `Renamed "${member.name}" label "${before ?? '—'}" → "${member.optionLabel}"`,
      { organizationId: this.organizationIdOf(parent) },
    );
    return { parentId: parent.id, member: this.toMember(member) };
  }

  async removeMember(
    parentId: string,
    memberId: string,
    actor: Actor,
    scope?: TenantScope,
  ): Promise<FamilyMutationResult> {
    const em = this.productRepository.getEntityManager();
    const result = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        const parent = await this.loadParent(tem, parentId, narrowedOf(scope));
        const member = this.memberOf(parent, memberId);

        // Releasing the LAST child makes the card sellable — that is one
        // exposure this transition validates. The OTHER (Phase 2): the
        // released member stops inheriting the parent's specification values,
        // so its own published branches must still be answered afterwards.
        const fresh = await this.publicationGuard.withFamilyShapeLocks(tem, async () => {
          const children = await tem.find(Product, { parent: parent.id }, { refresh: true });
          const stillChild = children.some((child) => child.id === memberId);
          const remaining = children.filter((child) => child.id !== memberId).length;
          const parentStoreIds =
            stillChild && remaining === 0 ? await this.publicationGuard.publishedStoreIds(tem, parent.id) : [];
          const leaving = children.find((child) => child.id === memberId) ?? null;
          const memberStoreIds =
            leaving && leaving.status === ProductStatus.PUBLISHED && !leaving.archivedAt
              ? await this.publicationGuard.publishedStoreIds(tem, memberId)
              : [];
          return {
            familyRootIds: [parent.id, memberId],
            validationStoreIds: [...parentStoreIds, ...memberStoreIds],
            parentStoreIds,
            memberStoreIds,
            stillChild,
          };
        });
        if (!fresh.stillChild) throw new NotFoundException(`Item ${memberId} is not a child of this parent`);

        member.parent = null;
        member.optionLabel = undefined;
        await tem.flush();
        // ...and a departing child narrows it, so the card stops being
        // advertised in a store where nothing of it is left. A release that
        // empties the family changes nothing here: see reconcileStoresOfParent.
        await this.publicationGuard.reconcileStoresOfParent(tem, parent.id, this.organizationIdOf(parent));
        // The shape is final only now — a card with zero children is sellable,
        // and must answer what its published branches require. The released
        // member is validated WITHOUT its former parent: inheritance is gone,
        // and a missing required answer rolls the release back whole.
        await this.publicationGuard.assertPublishable(tem, parent, fresh.parentStoreIds);
        await this.publicationGuard.assertPublishable(tem, member, fresh.memberStoreIds);
        return {
          parent: { id: parent.id, name: parent.name },
          member: this.toMember(member),
          organizationId: this.organizationIdOf(parent),
        };
      }),
    );

    await this.audit(
      actor,
      result.parent.id,
      Action.UPDATE,
      `Released "${result.member.name}" from parent "${result.parent.name}"`,
      { organizationId: result.organizationId },
    );
    return { parentId: result.parent.id, member: result.member };
  }

  /** Every child becomes a standalone product again; the parent stays a product. */
  async dissolve(parentId: string, actor: Actor, scope?: TenantScope): Promise<FamilyDissolveResult> {
    const em = this.productRepository.getEntityManager();
    const result = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        const parent = await this.loadParent(tem, parentId, narrowedOf(scope));
        if (parent.children.getItems().length === 0) {
          throw new BadRequestException('This product has no children to release');
        }

        // Dissolving always ends at zero children, so the card's published
        // exposure is always validated. Every released member also stops
        // inheriting (Phase 2), so each one's own published exposure is
        // validated too. Every released member's post-transition root rides
        // along for serialization.
        const fresh = await this.publicationGuard.withFamilyShapeLocks(tem, async () => {
          const children = await tem.find(Product, { parent: parent.id }, { refresh: true });
          const parentStoreIds =
            children.length > 0 ? await this.publicationGuard.publishedStoreIds(tem, parent.id) : [];
          const memberStoreIds = new Map<string, string[]>();
          for (const child of children) {
            if (child.status === ProductStatus.PUBLISHED && !child.archivedAt) {
              const exposed = await this.publicationGuard.publishedStoreIds(tem, child.id);
              if (exposed.length > 0) memberStoreIds.set(child.id, exposed);
            }
          }
          return {
            familyRootIds: [parent.id, ...children.map((child) => child.id)],
            validationStoreIds: [...parentStoreIds, ...Array.from(memberStoreIds.values()).flat()],
            parentStoreIds,
            memberStoreIds,
            children,
          };
        });
        if (fresh.children.length === 0) throw new BadRequestException('This product has no children to release');

        for (const member of fresh.children) {
          member.parent = null;
          member.optionLabel = undefined;
        }
        await tem.flush();
        await this.publicationGuard.assertPublishable(tem, parent, fresh.parentStoreIds);
        for (const member of fresh.children) {
          await this.publicationGuard.assertPublishable(tem, member, fresh.memberStoreIds.get(member.id) ?? []);
        }
        return {
          parent: { id: parent.id, name: parent.name },
          released: fresh.children.length,
          organizationId: this.organizationIdOf(parent),
        };
      }),
    );

    await this.audit(
      actor,
      result.parent.id,
      Action.UPDATE,
      `Dissolved parent "${result.parent.name}": released ${result.released} child products`,
      { organizationId: result.organizationId },
    );
    return { parentId: result.parent.id, released: result.released };
  }

  /**
   * P5-A2 canonical family 7: the branch confinement is the RESOLVED
   * NARROWING, not `actor.store`. The controller has already proved the
   * product belongs to the caller's organization; this keeps a caller working
   * inside one branch confined to the products that branch carries.
   */
  private async loadParent(tem: EntityManager, parentId: string, narrowedTo: string | null): Promise<Product> {
    const parent = await tem.findOne(
      Product,
      { id: parentId, ...(narrowedTo ? { stores: narrowedTo } : {}) },
      { populate: ['children'] },
    );
    if (!parent) throw new NotFoundException(`Item ${parentId} not found`);
    if (parent.parent)
      throw new BadRequestException('A child cannot have children; manage this from the parent product');
    return parent;
  }

  /**
   * EVERYTHING BOTH ATTACHMENT RULES DECIDE ON, READ UNDER ROW LOCKS.
   *
   * A child reaches a shopper only through its card, so an attachment may not
   * hand a live child to a card that cannot carry it. Two independent ways for
   * the card to fail that — it is not live at all, or it is hidden in a branch
   * the child is published in — and both are facts about rows another
   * transaction can change while this one decides.
   *
   * The advisory keys do not cover either. `withFamilyShapeLocks` holds the two
   * family roots, which serialises this against every write that goes through
   * the guard. The writers that change the card's own state do not go through
   * it: `PATCH /products/:id` with `{ status }` takes keys only when it
   * changes membership or publishes, so drafting a card takes none;
   * `bulkStatus` to draft takes none; `archive` is not even transactional.
   *
   * So the CARD'S OWN STATE is read here too, under `FOR SHARE`, and both rules
   * are evaluated from these rows rather than from the entities this
   * transaction opened with. Without that, a card drafted or archived between
   * the load and the decision left a live child behind a card nobody can see —
   * exactly what the rules exist to refuse.
   *
   * `FOR SHARE` is the weakest lock that blocks them: drafting writes `status`
   * and archiving writes `archived_at`, both non-key UPDATEs, which `FOR SHARE`
   * blocks and `FOR KEY SHARE` does not.
   *
   * THE MEMBER'S ROW IS TAKEN AT WRITE STRENGTH FIRST, `FOR UPDATE`, because
   * this transaction is about to write it, and this is the one row lock here
   * that may WAIT. At that point this transaction holds advisory keys and no
   * row, so its wait is part of no cycle. Taken `FOR SHARE` instead, it
   * deadlocked with any stock posting on the member: a posting applies its
   * balance, and the #292 trigger on `inventory_balances` takes `FOR SHARE`
   * on the product row; it then refreshes the cached totals with an UPDATE
   * of that same row. Holding `FOR SHARE` here, this transaction's own UPDATE
   * of the member waited on the posting's share, and the posting's UPDATE
   * waited on this one's: `40P01`.
   *
   * EVERY OTHER ROW IS TAKEN WITH `NOWAIT`. Holding the member's row, this
   * transaction may not wait for a second row: a writer that has written the
   * card's row and goes on to touch the member — an import batch updating
   * both, a sale issuing stock for both, line by line — would be waiting on
   * the member while this waited on the card. So the card's row and the
   * pivots are asked for `FOR SHARE NOWAIT`. A refusal (`55P03`) is raised as
   * `RowLockUnavailableError`; `addMember` rolls the attempt back whole,
   * waits for the busy rows holding nothing, and starts again.
   *
   * Held against real PostgreSQL, in both orders, against: a stock posting on
   * the member; a stock posting on the card; an import batch that writes the
   * card and then the member; and a sale that issues stock for the card and
   * then the member. The posting driven is the stock set a
   * `PATCH { stockQuantity }` makes and the sale's per-line issue; by reading,
   * the same posting path serves reservations, receipts, transfers and the
   * import applier.
   *
   * `FOR SHARE` for the card's row because it is only ever read here; a
   * posting on the card that reaches its UPDATE waits for this share, and one
   * that holds the row already makes this transaction start again.
   *
   * Only EXISTING rows can be locked, and only the pivots in branches the
   * company still has are read (see the read). For the card's pivots that is
   * exactly the set the branch rule decides on: a branch the card does not
   * hold yet is created published by `reconcileStoresOfParent`. A pivot of
   * the member being inserted beside this transaction is waited for by the
   * member's `FOR UPDATE` — the insert's foreign-key check holds the member's
   * row — and is then read; if it is in a branch the keys were not named for,
   * the caller starts again (see the call site).
   */
  private async lockedFamilyVisibility(
    tem: EntityManager,
    parentId: string,
    memberId: string,
  ): Promise<{
    parent: { status: string; archivedAt: Date | null };
    member: { status: string; archivedAt: Date | null };
    hiddenIn: { id: string; name: string }[];
    /** Every branch the company still has that the card holds a pivot in, published or not, as locked. */
    cardBranches: string[];
    /** Every branch the company still has that the member holds a pivot in, published or not, as locked. */
    memberBranches: string[];
  }> {
    /*
     * Through the ORM where the ORM has the lock: `PESSIMISTIC_WRITE` is
     * `FOR UPDATE`, `PESSIMISTIC_READ_OR_FAIL` is `FOR SHARE NOWAIT`. The #290
     * query-surface census keeps unannotated raw reads of `products` out of
     * the tree; a raw lock on it would need its annotation and gains nothing.
     */
    const member = await tem.findOne(
      Product,
      { id: memberId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    if (!member) throw new NotFoundException(`Item ${memberId} not found`);
    const refused = (table: RowLockUnavailableError['rows']['table'], err: unknown) =>
      isLockNotAvailable(err) ? new RowLockUnavailableError({ table, ids: [parentId, memberId] }) : err;
    const card = await tem
      .findOne(Product, { id: parentId }, { lockMode: LockMode.PESSIMISTIC_READ_OR_FAIL, refresh: true })
      .catch((err) => {
        throw refused('products', err);
      });
    if (!card) throw new NotFoundException(`Item ${parentId} not found`);
    const stateOf = (row: Product) => ({ status: String(row.status), archivedAt: row.archivedAt ?? null });

    /*
     * THE VIEW THE ORM DECIDES FROM. The reads the keys are named from and
     * the reads the reconciliation derives from all go through the ORM, whose
     * removed filter on `Store` reaches through the pivot's relation: a pivot
     * in a branch the company has REMOVED does not exist for any of them. A
     * raw read sees it. Compared unfiltered, it was a branch the keys were
     * never named for, on every attempt, and the attachment was refused for
     * good. So this read applies the filter the ORM applies, and locks only
     * the pivot rows — a store's row is nobody's to hold here.
     */
    const locked = (await tem
      .execute(
        `select sp.product_id, sp.store_id, sp.published
         from store_products sp
         join stores s on s.id = sp.store_id
        where sp.product_id in (?, ?)
          and s.removed_at is null
        order by sp.id
          for share of sp nowait`,
        [parentId, memberId],
      )
      .catch((err) => {
        throw refused('store_products', err);
      })) as { product_id: string; store_id: string; published: boolean }[];

    const memberPublishedIn = new Set(
      locked.filter((row) => row.product_id === memberId && row.published).map((row) => row.store_id),
    );
    const hiddenStoreIds = locked
      .filter((row) => row.product_id === parentId && !row.published && memberPublishedIn.has(row.store_id))
      .map((row) => row.store_id);

    // Named, not numbered: the refusal has to be actionable by somebody looking
    // at their own branch list.
    const stores = hiddenStoreIds.length
      ? await tem.find(Store, { id: { $in: hiddenStoreIds } }, { refresh: true })
      : [];
    const nameOf = new Map(stores.map((store) => [store.id, store.name]));
    return {
      parent: stateOf(card),
      member: stateOf(member),
      hiddenIn: hiddenStoreIds.map((id) => ({ id, name: nameOf.get(id) ?? id })),
      cardBranches: locked.filter((row) => row.product_id === parentId).map((row) => row.store_id),
      memberBranches: locked.filter((row) => row.product_id === memberId).map((row) => row.store_id),
    };
  }

  private memberOf(parent: Product, memberId: string): Product {
    const member = parent.children.getItems().find((child) => child.id === memberId);
    if (!member) throw new NotFoundException(`Item ${memberId} is not a child of this parent`);
    return member;
  }

  /** Delegates to the shared rule, so every label writer decides identically. */
  private assertLabelFree(siblings: Product[], label: string, exceptId?: string): void {
    assertLabelFree(siblings, label, exceptId);
  }

  private organizationIdOf(product: Product): string | null {
    return (product.organization as any)?.id ?? (product.organization as any) ?? null;
  }

  private toMember(member: Product): { id: string; name: string; label: string | null } {
    return { id: member.id, name: member.name, label: member.optionLabel ?? null };
  }

  private async audit(
    actor: Actor,
    productId: string,
    action: Action,
    message: string,
    context: AuditContext,
  ): Promise<void> {
    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.PRODUCT,
      productId,
      action,
      null,
      message,
      context,
    );
  }
}
