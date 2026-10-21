import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { FlushMode } from '@mikro-orm/core';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { Product } from '../entities/product.entity';
import {
  assertEligibleAsChild,
  assertLabelFree,
  assertUniformPublicationStatus,
  FamilyMemberRefusal,
  assertFamilyRequestShape,
  assertNotAFamilyCard,
  assertIdentityFieldUnchanged,
} from '../families/family-membership';
import { Category } from '../../categories/entities/category.entity';
import { Store } from '../../stores/entities/store.entity';
import { StoreProduct } from '../entities/store-product.entity';
import { StorePriceDto } from '../dto/create-product.dto';
import { CreateProductDto } from '../dto/create-product.dto';
import { BranchAssignmentDto } from '../dto/branch-assignment.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { ProductStatus } from './product-status.enum';
import { CategoriesService } from '../../categories/categories.service';
import { confidentGroups, normalizeGroupName } from '../../imports/preview/family-grouping';
import { blockedReasonsFor } from '../families/suggestion-readiness';
import { FamilyLearningService } from '../families/family-learning.service';
import { slugify } from '../../imports/preview/woocommerce-mapper';

/** `products.slug` is varchar(255); the generated slug must fit it. */
const PRODUCT_SLUG_MAX = 255;
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Actor } from '../../audit-log/types/actor.type';
import { EntityType, Action } from '../../audit-log/entities/audit-log.entity';
import { PublicationGuardService } from '../publication/publication-guard.service';
import { InventoryStockService } from '../../inventory/ledger/inventory-stock.service';
import { ProductFieldsService } from '../fields/product-fields.service';
import { normalizeManufacturerCode } from '../shared/manufacturer-code.util';

export { ProductListFilters, PRODUCT_ID_SNAPSHOT_CAP } from './product-query.service';
import { ProductListFilters, ProductQueryService } from './product-query.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    private readonly categoriesService: CategoriesService,
    private readonly auditLogService: AuditLogService,
    private readonly familyLearningService: FamilyLearningService,
    private readonly publicationGuard: PublicationGuardService,
    private readonly productFieldsService: ProductFieldsService,
    private readonly stock: InventoryStockService,
  ) {}

  private get productQuery(): ProductQueryService {
    return new ProductQueryService(this.productRepository, this.categoryRepository);
  }

  findAll(filters?: ProductListFilters) {
    return this.productQuery.findAll(filters);
  }

  findMatchingIdSnapshot(filters?: ProductListFilters, cap?: number) {
    return this.productQuery.findMatchingIdSnapshot(filters, cap);
  }

  findMatchingIds(filters?: ProductListFilters) {
    return this.productQuery.findMatchingIds(filters);
  }

  /**
   * PHASE 4: the ONE place a by-id product mutation gets its tenant clause.
   *
   * Products belong to the ORGANIZATION and are shared across its stores, so
   * the clause names the company and never the branch. It refuses a missing
   * organization instead of returning `{}` â€” the previous
   * `actor?.store ? { stores } : {}` silently became an unscoped query for any
   * store-less actor, which is a cross-company reach, not a wider permission.
   */
  private organizationScope(organizationId: string | null): { organization: string } {
    if (!organizationId) {
      throw new ForbiddenException(
        'This operation requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    return { organization: organizationId };
  }

  /**
   * Items already in the catalogue that look like one model in several
   * versions. Anything already filed in a variant group is left out, so a
   * suggestion disappears once it is acted on.
   */
  async findFamilySuggestions(
    /**
     * THE TENANT BOUNDARY, and it was missing.
     *
     * This query filtered by STORE when the caller was narrowed to one, and by
     * nothing at all otherwise â€” so an organization-wide reader, which is what
     * an ORGANIZATION_MANAGER always is, was proposed ungrouped products from
     * every company in the database. `buildProductWhere` has required the
     * company since Phase 4 for exactly this reason ("the company is the ONLY
     * tenant boundary"); this path never got the same treatment, and a
     * PostgreSQL test written for PR D is what found it.
     *
     * Required, and refused rather than defaulted: a suggestion list with no
     * company is not a smaller list, it is somebody else's catalogue.
     */
    organizationId?: string | null,
    storeScopeId?: string,
  ) {
    /*
     * NO ACTOR. It used to take one, purely so the company's vocabulary and
     * dismissals could be looked up from the caller's own user row â€” which is
     * the very thing that made this feature answer to two different companies.
     * Everything this reads is now decided by the scope, and a parameter that
     * decides nothing is a parameter that will be trusted again one day.
     */
    const scope = this.organizationScope(organizationId ?? null);

    // #177: childlessness is part of the WHERE now, so the database returns
    // only candidates instead of every family card plus every populated child
    // collection that a JS filter then threw away. Same result set, bounded.
    const ungrouped = await this.productRepository.find(
      {
        ...scope,
        archivedAt: null,
        parent: null,
        children: { $none: {} },
        ...(storeScopeId ? { stores: storeScopeId } : {}),
      },
      { limit: 5000 },
    );

    // Phase 2: this company's own vocabulary widens the net; its dismissals
    // silence a suggestion for good
    const [learnedWords, dismissedSignatures] = await Promise.all([
      // The SAME company the candidates were read under. Deriving it from the
      // actor instead put a platform owner's dismissals in a null bucket the
      // client never reads, so the two halves of one answer disagreed.
      this.familyLearningService.learnedWordsFor(scope.organization),
      this.familyLearningService.dismissedSignaturesFor(scope.organization),
    ]);

    const groups = confidentGroups(
      ungrouped.map((p) => ({ name: p.name, sku: p.sku })),
      { learnedWords, dismissedSignatures },
    );

    /*
     * READINESS, IN TWO QUERIES â€” not two per suggestion.
     *
     * A suggestion is a guess about NAMES. Whether it could actually be
     * created depends on shops, publication status and specification values,
     * and asking those per group would be a query per group per condition: an
     * N+1 on a page that exists to show many groups at once. Both facts are
     * fetched ONCE for every candidate member, and the rule is then applied in
     * memory.
     *
     * Nothing here writes. This is discovery, and the authoritative answer is
     * still `createFamily`'s own transaction.
     */
    const memberIds = Array.from(new Set(groups.flatMap((g) => g.members.map((m) => ungrouped[m.row].id))));
    const em = this.productRepository.getEntityManager();
    const withStore = new Set<string>();
    const withSpecificationConflict = new Set<string>();
    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',');
      const [storeRows, conflictRows] = await Promise.all([
        em.execute(
          `select distinct product_id from store_products where product_id in (${placeholders})`,
          memberIds,
        ) as Promise<{ product_id: string }[]>,
        // The member side of `assertMembersAttachable`, asked once for every
        // candidate instead of once per group.
        em.execute(
          `select distinct v.product_id from product_field_values v
             join product_field_definitions d on d.id = v.definition_id
            where v.product_id in (${placeholders})
              and (d.applicability = 'PARENT' or (d.applicability = 'BOTH' and not d.child_override_allowed))`,
          memberIds,
        ) as Promise<{ product_id: string }[]>,
      ]);
      for (const row of storeRows) withStore.add(row.product_id);
      for (const row of conflictRows) withSpecificationConflict.add(row.product_id);
    }

    return groups.map((group) => {
      const facts = group.members.map((m) => ({
        id: ungrouped[m.row].id,
        status: String(ungrouped[m.row].status),
        hasStore: withStore.has(ungrouped[m.row].id),
        hasSpecificationConflict: withSpecificationConflict.has(ungrouped[m.row].id),
        label: m.label,
      }));
      const blockedReasons = blockedReasonsFor(facts);
      return {
        name: group.name,
        readiness: blockedReasons.length === 0 ? ('READY' as const) : ('BLOCKED' as const),
        blockedReasons,
        members: group.members.map((m) => ({
          id: ungrouped[m.row].id,
          name: m.name,
          label: m.label,
          price: ungrouped[m.row].price,
          // What the interface needs to EXPLAIN the verdict, rather than
          // re-derive it: which member is the draft, which has no shop.
          status: String(ungrouped[m.row].status),
          hasStore: withStore.has(ungrouped[m.row].id),
          hasSpecificationConflict: withSpecificationConflict.has(ungrouped[m.row].id),
        })),
      };
    });
  }

  /**
   * "No, these are not one product" â€” remembered for the whole company.
   *
   * A PERSISTENT ORGANIZATION-WIDE WRITE, so it answers to the request's
   * resolved scope and not to the caller's own user row, and it refuses
   * without a company rather than writing where nobody reads.
   *
   * A signature is dismissable only if it is one of the suggestions THIS scope
   * can see. That is what stops a branch-narrowed actor silencing a group that
   * lives in a sibling branch, and a company silencing another company's. The
   * refusal is deliberately the same sentence whether the signature belongs to
   * someone else or to nobody at all â€” a different answer for the two would
   * turn this route into a way to ask whether another company has a group.
   *
   * Already-dismissed signatures stay accepted, so pressing Dismiss twice is
   * the same as pressing it once: the permanence of a "No" is unchanged.
   */
  async dismissFamilySuggestion(
    name: string,
    organizationId: string | null,
    storeScopeId?: string,
  ): Promise<{ signature: string }> {
    const scope = this.organizationScope(organizationId ?? null);
    const signature = normalizeGroupName(name);

    const already = await this.familyLearningService.isDismissed(scope.organization, signature);
    if (!already) {
      const visible = await this.findFamilySuggestions(organizationId, storeScopeId);
      const mine = visible.some((suggestion) => normalizeGroupName(suggestion.name) === signature);
      if (!mine) throw new NotFoundException('That suggestion is not one of yours.');
    }

    return this.familyLearningService.dismissSuggestion(name, scope.organization);
  }

  /**
   * THE validation prelude for creating a family â€” the one both entry points
   * run, in one place, in one order.
   *
   * `validateFamilyCreation` used to carry its own copy of the loop, and the
   * copy was not equal: it never reached `assertMembersAttachable`, so a static
   * specification conflict returned `ok: true` and was refused only at the
   * confirmation, after the reader had been told it would work. A prelude that
   * is "the same rules" by intention rather than by construction drifts exactly
   * like that, so there is now nothing to keep in step.
   *
   * Every check is a READ. Which entity manager it runs on is the caller's
   * choice, and that is the only difference between the two callers: the
   * preflight passes a plain manager and opens no transaction; creation passes
   * its transactional one and repeats the whole prelude under its locks, which
   * is the authoritative answer.
   *
   * Returns the resolved members, in the order the caller sent them â€” every
   * rule that must not depend on that order sorts for itself.
   */
  private async assertFamilyCreatable(
    em: EntityManager,
    name: string,
    members: { id: string; label: string }[],
    storeScopeId: string | undefined,
  ): Promise<Product[]> {
    assertFamilyRequestShape(name, members);
    // The same product twice would attach it once and then clash with itself
    // on the second pass, halfway through a write. Refused up front, before
    // anything is looked up.
    const seenIds = new Set<string>();
    for (const member of members) {
      if (seenIds.has(member.id)) {
        throw new BadRequestException('The same item was listed twice. Each child can only join the family once.');
      }
      seenIds.add(member.id);
    }

    const products: Product[] = [];
    for (const member of members) {
      const product = await em.findOne(
        Product,
        { id: member.id, ...(storeScopeId ? { stores: storeScopeId } : {}) },
        // `children` is populated for the shared eligibility guard: an unloaded
        // collection reports zero and would let a parent through. `categories`
        // is what creation copies onto the card; the preflight does not need it
        // but loads it anyway, because a prelude that populates differently for
        // its two callers is a prelude that can answer differently.
        { populate: ['categories', 'stores', 'children'] },
      );
      if (!product) throw new NotFoundException(`Item ${member.id} not found`);
      // The SAME rules the attachment endpoint applies, from one place.
      assertEligibleAsChild(product);
      // ...and the SAME label rule. This path assigned whatever arrived, so a
      // blank label, or two differing only in case, produced selector options a
      // shopper cannot read or tell apart. Each label is checked against the
      // ones already accepted in THIS request.
      assertLabelFree(
        products.map((accepted, i) => ({ id: accepted.id, name: accepted.name, optionLabel: members[i].label })),
        member.label,
      );
      products.push(product);
    }

    // Whole-selection rules, once every member is known.
    assertUniformPublicationStatus(products.map((p) => ({ id: p.id, name: p.name, status: String(p.status) })));
    // Becoming a version changes which specification values are legal: a member
    // carrying model-only or override-forbidden values refuses here. The parent
    // is `null` because the card does not exist yet in either caller â€” the
    // preflight has no card at all, and creation's card is freshly minted and
    // holds no values.
    await this.publicationGuard.assertMembersAttachable(
      em,
      products.map((product) => product.id),
      null,
    );

    return products;
  }

  /**
   * Would this grouping be accepted? â€” asked WITHOUT writing anything.
   *
   * It calls `assertFamilyCreatable`, which is the same method â€” not the same
   * intention â€” that `createFamily` calls before it writes. This method's only
   * job is to reach it without a transaction and turn a refusal into a verdict.
   *
   * ADVISORY, and deliberately so. Between this answer and a confirmation the
   * catalogue can move: an item can be grouped by somebody else, archived, or
   * dropped from its last store. `createFamily` repeats every check inside its
   * transaction, and that repetition is the authoritative one.
   *
   * Writes NOTHING: no product, no pivot, no parent, no audit entry and no
   * learned vocabulary. It opens no transaction at all.
   */
  async validateFamilyCreation(
    name: string,
    members: { id: string; label: string }[],
    narrowedStoreId: string | null = null,
  ): Promise<{ ok: boolean; problem: { message: string; productId?: string } | null }> {
    // A FORK, cleared: the prelude resolves entities to read them, and this
    // method must leave nothing behind in the manager its caller shares.
    const em = this.productRepository.getEntityManager().fork({ clear: true }) as EntityManager;
    const storeScopeId = narrowedStoreId ?? undefined;
    try {
      await this.assertFamilyCreatable(em, name, members, storeScopeId);
      return { ok: true, problem: null };
    } catch (err: any) {
      // The refusal names the offending product when it knows it; otherwise
      // fall back to scanning the sentence for an id it may have quoted.
      const named = err instanceof FamilyMemberRefusal ? err.productId : undefined;
      const quoted = members.find((m) => (err?.message ?? '').includes(m.id))?.id;
      return {
        ok: false,
        problem: {
          // The guard's structured refusals put their sentence on `response`;
          // the membership rules put theirs on `message`. Both are already
          // written for a reader, and neither is reshaped here.
          message: err?.response?.message ?? err?.message ?? 'This grouping cannot be made.',
          productId: named ?? quoted,
        },
      };
    }
  }

  /**
   * Files existing items into one family: creates the parent product (the
   * card the website shows) and points the members at it as its versions.
   */
  async createFamily(
    name: string,
    members: { id: string; label: string; name?: string }[],
    actor?: { id: string; email: string },
    narrowedStoreId: string | null = null,
    /**
     * What the CARD says about itself (PR C). Everything else about it is
     * derived from the members: its status, its sorting price, its categories
     * and its stores. Absent fields stay null â€” a card created before these
     * existed is not retroactively given anything.
     */
    descriptive: { description?: string; metaTitle?: string; metaDescription?: string } = {},
    /**
     * The request's RESOLVED company, used for the vocabulary this creation
     * teaches. Not derived from the actor: a platform owner working inside a
     * client has no company of their own, and the lesson belongs to the client.
     */
    organizationId: string | null = null,
  ) {
    // Cheap enough to answer without a database, so it is answered before one
    // is opened: a request naming nothing, or naming a single item, never gets
    // as far as a transaction. The prelude asserts it again from inside.
    assertFamilyRequestShape(name, members);

    const em = this.productRepository.getEntityManager();
    const storeScopeId = narrowedStoreId ?? undefined;

    // The card, its pivots and its versions' parent links are ONE fact: they
    // commit or roll back together, and a widened lock set restarts the whole
    // creation against a fresh entity graph (B4a3).
    const created = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        // THE authoritative pass. The preflight ran these same checks against a
        // catalogue that may since have moved, so they are repeated here, under
        // this transaction, and it is this answer that decides.
        const products = await this.assertFamilyCreatable(tem, name, members, storeScopeId);

        // THE CARD MUST NOT DEPEND ON THE ORDER MEMBERS ARRIVED IN.
        //
        // The lead used to be `products[0]` â€” whatever the caller happened to
        // list first â€” so the same three items selected in a different order
        // produced a card with a different status and a different sorting
        // price. Sorting here rather than trusting the caller is what makes the
        // result a property of the SELECTION instead of the request.
        //
        // Lowest base price first, then product id as a stable tie-break.
        const ordered = [...products].sort((a, b) => {
          const ap = Number(a.price ?? 0);
          const bp = Number(b.price ?? 0);
          if (ap !== bp) return ap - bp;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const lead = ordered[0];
        const organizationId = (lead.organization as any)?.id ?? (lead.organization as any) ?? null;
        const parent = tem.create(Product, {
          name: name.trim(),
          slug: await this.uniqueProductSlug(name, organizationId),
          status: lead.status,
          organization: lead.organization ?? undefined,
          // The card's own copy. A blank string is not a value: it stores null
          // so an empty SEO field falls back to the name, as it does everywhere
          // else, instead of publishing an empty <title>.
          description: descriptive.description?.trim() || undefined,
          metaTitle: descriptive.metaTitle?.trim() || undefined,
          metaDescription: descriptive.metaDescription?.trim() || undefined,
          // The card needs a base price to sort and filter by; the lead's applies
          price: lead.price,
          // No stock: a family card is a container, refused at checkout. It is
          // born with the column's zero rather than an assignment here, so the
          // ledger stays the only thing that ever moves a quantity (P5-B3).
          trackInventory: false,
        } as any);
        // The parent appears in the same folders as its versions; their
        // branches arrive below as explicit pivots, never `stores.add()`,
        // which mints rows with no organization and â€” since publication
        // defaults to hidden â€” invisible cards.
        for (const product of products) {
          for (const category of product.categories.getItems()) {
            if (!parent.categories.getItems().some((c) => c.id === category.id)) parent.categories.add(category);
          }
        }
        const cardStoreIds = Array.from(new Set(products.flatMap((p) => p.stores.getItems().map((s) => s.id))));
        await tem.persistAndFlush(parent);

        // ONE combined acquisition: destination root, every member's
        // pre-transition root, and the card's target stores â€” so the guarded
        // pivot step below re-acquires only keys this transaction already
        // holds, in the same canonical order.
        await this.publicationGuard.withFamilyShapeLocks(tem, async () => {
          const rows = await tem.find(Product, { id: { $in: products.map((p) => p.id) } }, { refresh: true });
          return {
            familyRootIds: [parent.id, ...rows.map((row) => PublicationGuardService.familyRootIdOf(row))],
            validationStoreIds: cardStoreIds,
          };
        });

        // THE WHOLE PRELUDE AGAIN, now that the locks are held and the rows
        // have been re-read. The first pass refused before anything was
        // written; this one refuses on what is true while nobody else can move
        // it â€” a member grouped, unpublished or given a conflicting
        // specification value between the two passes is caught here, and the
        // transaction takes the card and its pivots down with it.
        //
        // The same method both times: there is no second, laxer copy of the
        // rules for the path that actually writes.
        //
        // On a FORK with an empty identity map, bound to this transaction, so
        // every row is genuinely re-read through the locks instead of being
        // answered from what the first pass already loaded. (`refresh: true` on
        // the shared manager reloads the columns but empties the populated
        // to-many collections, which would make the eligibility guard see a
        // member with no stores.)
        const verifier = tem.fork({ clear: true }) as EntityManager;
        verifier.setTransactionContext(tem.getTransactionContext());
        await this.assertFamilyCreatable(verifier, name, members, storeScopeId);

        /*
         * Children first, flushed, so the card is the nonsellable container
         * when its pivots are validated.
         *
         * A RENAME TRAVELS WITH THE GROUPING. Reviewing the items is the
         * moment a person notices that one of them is called "Silla Nordic
         * Verde 2" and should just be "Verde". Sending that as a separate
         * request afterwards would mean a group could exist with only some of
         * the names the person confirmed â€” so it happens here, inside the one
         * transaction, and rolls back with everything else if anything later
         * refuses.
         *
         * Only the name. The slug is what existing links point at, the SKU is
         * what stock is counted against, and images, prices, publication and
         * translations were never part of this request: renaming an item here
         * touches exactly what renaming an item anywhere else touches.
         */
        const renamed: { product: Product; before: string }[] = [];
        products.forEach((product, i) => {
          product.parent = parent;
          product.optionLabel = members[i].label;
          const requested = members[i].name?.trim();
          if (requested && requested !== product.name) {
            renamed.push({ product, before: product.name });
            product.name = requested;
          }
        });
        await tem.flush();

        await this.publicationGuard.applyGuardedPublication(tem, parent, organizationId, {
          storeIds: cardStoreIds,
          publishingAll: false,
        });
        await tem.flush();

        // THE AUDIT ENTRY COMMITS WITH THE FAMILY, not after it.
        //
        // `recordAuditEntry` swallows its own failures by design, so a family
        // could be created and its record silently lost â€” an unaudited change
        // to what a shop sells. `recordAuditEntryIn` writes through THIS
        // transaction and throws, so the card, its pivots and every parent
        // link roll back with the record that describes them, and a rolled-back
        // family leaves no entry claiming it existed.
        if (actor) {
          await this.auditLogService.recordAuditEntryIn(
            tem,
            actor.id,
            actor.email,
            EntityType.PRODUCT,
            parent.id,
            Action.CREATE,
            /*
             * THE NAMES LIVE IN `changes`, NOT IN THE SENTENCE.
             *
             * `audit_logs.message` is varchar(255). The old sentence embedded
             * the card's name, which this endpoint allows up to 255 on its
             * own, so naming a card anything long enough made the INSERT that
             * records the family fail â€” and because that insert commits with
             * the family, the whole grouping failed with a server error. The
             * sentence is now a constant and every variable part is structured
             * data, which is jsonb and has no such ceiling.
             */
            { name: { before: null, after: parent.name }, memberCount: products.length },
            'Created a parent card with child products.',
            { organizationId },
          );
          /*
           * EACH RENAME IS ITS OWN RECORD, against the item that was renamed.
           * Folding them into the card's CREATE entry would leave the log
           * unable to answer "when did this item's name change?", which is the
           * question the log exists for. Written through this transaction, so
           * a family that rolls back leaves no entry claiming a rename.
           */
          for (const { product, before } of renamed) {
            await this.auditLogService.recordAuditEntryIn(
              tem,
              actor.id,
              actor.email,
              EntityType.PRODUCT,
              product.id,
              Action.UPDATE,
              // `{ before, after }` is the shape every other product edit
              // writes (see `update`), so one reader serves them all. Both
              // names may be 255 on their own, so neither goes in the message:
              // that column is varchar(255) and the row commits with the
              // family, so an overflow here would fail the whole grouping.
              { name: { before, after: product.name } },
              'Renamed while grouping.',
              { organizationId },
            );
          }
        }
        return { id: parent.id, name: parent.name, memberCount: products.length, organizationId };
      }),
    );

    // Accepting teaches: these labels join the company's trusted vocabulary.
    // NON-AUTHORITATIVE and deliberately after the commit â€” a suggestion
    // heuristic failing must not undo a family somebody just made. The
    // authoritative record is the audit entry written inside the transaction
    // above.
    await this.familyLearningService.learnFromAcceptedGroup(
      members.map((m) => m.label),
      organizationId ?? null,
    );

    return { id: created.id, name: created.name, members: created.memberCount };
  }

  /**
   * Product slugs are unique per organization; suffix until free.
   *
   * The suffix is made to FIT rather than truncated after the fact. `slugify`
   * does not cap its output, `products.slug` is varchar(255), and the old code
   * appended `-2` to whatever it had â€” so a 255-character name that collided
   * produced a 257-character slug and the insert failed. Trimming the base by
   * exactly the suffix's width keeps the collision loop able to make progress.
   *
   * Ordinary names are untouched: nothing is trimmed unless the candidate
   * would otherwise exceed the column.
   */
  private async uniqueProductSlug(name: string, organizationId?: string | null): Promise<string> {
    const base = (slugify(name) || 'modelo').slice(0, PRODUCT_SLUG_MAX);
    const fit = (suffix: string): string =>
      `${base.slice(0, PRODUCT_SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    let candidate = base;
    let n = 2;
    while (
      await this.productRepository.findOne({
        slug: candidate,
        ...(organizationId ? { organization: organizationId } : {}),
      })
    ) {
      candidate = fit(`-${n}`);
      n += 1;
    }
    return candidate;
  }

  /**
   * Assigns a product to one branch, or updates how that branch sells it,
   * without touching any other branch (P0-06). The store must belong to the
   * product's organization â€” a foreign store behaves as if it did not exist.
   */
  async assignToStore(
    productId: string,
    storeId: string,
    dto: BranchAssignmentDto,
    actor?: Actor,
  ): Promise<StoreProduct> {
    const em = this.productRepository.getEntityManager();

    if (dto.salePrice != null && dto.price != null && dto.salePrice > dto.price) {
      throw new BadRequestException('Sale price cannot exceed the regular price');
    }

    // One fresh transaction per attempt (B4a3): publishing here is a direct
    // publication writer, so it runs the same derive â†’ lock â†’ rederive â†’
    // validate protocol as every other one, and a widened exposure restarts
    // the whole assignment against a fresh entity graph.
    const { link, product, store } = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        const product = await tem.findOne(Product, { id: productId });
        if (!product) throw new NotFoundException(`Product with ID ${productId} not found`);

        const store = await tem.findOne(
          Store,
          { id: storeId, archivedAt: null },
          { populate: ['organization'] as never },
        );
        const productOrgId = (product as any).organization?.id ?? (product as any).organization ?? null;
        const storeOrgId = (store as any)?.organization?.id ?? (store as any)?.organization ?? null;
        if (!store || (productOrgId && storeOrgId && productOrgId !== storeOrgId)) {
          throw new NotFoundException(`Store with ID ${storeId} not found`);
        }

        /*
         * EVERY ASSIGNMENT DECIDES UNDER THE PRODUCT'S FAMILY LOCK.
         *
         * Whether this product is a card is a family-shape fact, and an
         * attachment changes it: `POST :id/family/members` may promote a
         * product with no children, holding that product's family key while it
         * does. Counting children outside that key let a price-only or
         * `published: false` PUT on the soon-to-be card read "no children",
         * create or hide the card's pivot in a branch, and commit beside the
         * attachment â€” leaving the new version, already published in that
         * branch, behind a card nobody can see. Neither write alone permits
         * that end state; only the interleaving did.
         *
         * So the family root is ALWAYS in the lock set, not only when this
         * write newly publishes. The store key joins it only when it does, so
         * a publishing PUT takes exactly the keys it always took, in the same
         * canonical order, and a PUT that publishes nothing takes the family
         * key alone â€” never a store key after a family key.
         *
         * Everything the decision rests on is re-read inside the derivation,
         * which this protocol runs twice: once to name the locks and once while
         * they are held. The second read is the one returned, so the child
         * count, the product's own parent (which names the root) and both
         * pivots are the state as it stands under the lock. A root that moved
         * between the reads widens the set, and the whole assignment restarts.
         */
        const fresh = await this.publicationGuard.withFamilyShapeLocks(tem, async () => {
          const self = await tem.findOne(Product, { id: productId }, { refresh: true });
          if (!self) throw new NotFoundException(`Product with ID ${productId} not found`);
          const childCount = await tem.count(Product, { parent: productId });
          const current = await tem.findOne(StoreProduct, { store: storeId, product: productId }, { refresh: true });
          // This operation newly exposes the product here iff the final link is
          // published and the current one is not (or does not exist). A link
          // that stays published, stays hidden, or is being unpublished changes
          // no exposure â€” and nothing is ever unpublished implicitly: only an
          // explicit `published: false` in the body does that.
          const exposes = dto.published === true && !current?.published;
          // The card this product is a version of, if any. Read for the lock
          // set below, not to decide anything: whether a version may be
          // PUBLISHED behind a hidden card is a separate question on a separate
          // endpoint, and this change does not answer it.
          const parentRef = self.parent as unknown as { id?: string } | string | null | undefined;
          const parentId = (typeof parentRef === 'string' ? parentRef : (parentRef?.id ?? null)) || null;
          /*
           * THE KEYS THE NESTED RECONCILIATION WILL NEED, NAMED HERE.
           *
           * `reconcileParentStores` runs after the write, in this transaction
           * and therefore under the family key this block takes. It acquires a
           * store key for every store the card GAINS â€” and a namespace-1 key
           * taken while a namespace-2 key is held is the one ordering the
           * codebase forbids, because other writers take them the other way
           * round and the two deadlock.
           *
           * It was reachable: a body that publishes nothing but CREATES the
           * child's pivot gives the card a store while naming no store key at
           * all. Proved against real PostgreSQL â€” `pg_advisory_xact_lock` on
           * namespace 1 answered `deadlock detected` â€” before this existed.
           *
           * So those keys join the lock set here, from the guard's own
           * definition of what the card would gain, and `acquire` sorts them
           * ahead of the family key. The reconciliation then re-acquires keys
           * this transaction already holds, which is free.
           *
           * What this write VALIDATES is unchanged: `exposeStoreIds` stays
           * exactly the store it newly publishes in. Locking a store is not
           * claiming to publish in it.
           */
          const gains = parentId
            ? await this.publicationGuard.storesToGain(tem, parentId, current ? [] : [storeId])
            : [];
          const exposeStoreIds = exposes ? [storeId] : [];
          return {
            familyRootIds: [PublicationGuardService.familyRootIdOf(self)],
            validationStoreIds: Array.from(new Set([...exposeStoreIds, ...gains])),
            exposeStoreIds,
            childCount,
            current,
            parentId,
          };
        });

        // A card's shops are the union of its children's, reconciled on every
        // child move. Assigning one directly leaves a listing that survives
        // only until the next reconciliation quietly removes it â€” drift with a
        // delayed, invisible correction. Refused instead, on the child count
        // read under the family lock.
        assertNotAFamilyCard(
          { id: product.id, name: product.name, childCount: fresh.childCount },
          'its shops are worked out from its child products',
        );
        // The existing publication guard, over exactly the store this write
        // newly exposes; `withFamilyShapeLocks` deliberately leaves validation
        // to its caller. Nothing is validated for a write that shows nothing.
        await this.publicationGuard.assertPublishable(tem, product, fresh.exposeStoreIds);

        // The pivot is created or touched strictly AFTER validation.
        let link = fresh.current;
        if (!link) {
          link = tem.create(StoreProduct, {
            organization: (productOrgId as any) ?? undefined,
            store,
            product,
          } as any);
          tem.persist(link);
        }
        if (dto.published !== undefined) link.published = dto.published;
        if (dto.price !== undefined) link.price = dto.price;
        if (dto.salePrice !== undefined) link.salePrice = dto.salePrice;
        if (dto.cost !== undefined) link.cost = dto.cost;
        // P5-B3: a branch quantity is a movement at that branch's custody
        // location, not an assignment to a column. The posting mechanism
        // refreshes the compatibility value from the ledger afterwards.
        if (dto.stockQuantity !== undefined) {
          await this.stock.setBranchQuantity(tem as EntityManager, {
            organizationId: productOrgId as string,
            storeId: store.id ?? store,
            productId: product.id,
            targetQuantity: dto.stockQuantity,
            origin: 'branch-assignment',
            actor: actor ? { id: actor.id, email: actor.email } : null,
          });
        }
        if (dto.trackInventory !== undefined) link.trackInventory = dto.trackInventory;
        if (dto.leadTimeDays !== undefined) link.leadTimeDays = dto.leadTimeDays;
        await tem.flush();
        // Assigning a CHILD to a store widens its parent's derived membership.
        // This path writes the pivot directly rather than through
        // applyGuardedPublication, so it reconciles for itself.
        await this.publicationGuard.reconcileParentStores(tem, product, productOrgId as string | null);
        return { link, product, store };
      }),
    );

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT,
        product.id,
        Action.UPDATE,
        null,
        `Updated "${product.name}" in store "${store.name}"`,
        {
          organizationId: (product as any).organization?.id ?? (product as any).organization ?? null,
          storeId: store.id,
        },
      );
    }
    return link;
  }

  /** Removes a product from one branch; every other branch keeps it. */
  async removeFromStore(productId: string, storeId: string, actor?: Actor): Promise<void> {
    const em = this.productRepository.getEntityManager();
    // The removal and the parent's derived membership are ONE fact: a card
    // still advertised in a store its last child just left is exactly the
    // drift this closes, so they commit or roll back together.
    //
    // One fresh transaction per attempt, like every other membership writer: a
    // removal used to take no key at all, so it could not be restarted either.
    const link = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        const found = await tem.findOne(
          StoreProduct,
          { store: storeId, product: productId },
          { populate: ['product', 'store'] as never },
        );
        if (!found) throw new NotFoundException('That product is not assigned to that store');
        // The product as the database has it now, not as the request's entity
        // manager remembers it: see `update`. It is the same object either
        // way â€” the read refreshes it in place.
        const child =
          (await tem.findOne(Product, { id: productId }, { refresh: true, flushMode: FlushMode.COMMIT })) ??
          (found.product as unknown as Product);
        // Same rule from the other direction: removing a card from a shop its
        // children still serve is undone by the next reconciliation.
        const what = 'its shops are worked out from its child products';
        assertNotAFamilyCard(
          { id: child.id, name: child.name, childCount: await tem.count(Product, { parent: child.id }) },
          what,
        );
        // That answer is as old as the read. A removal exposes nothing, so it
        // names no store â€” but it holds its family key, and asks again under
        // it, so a product promoted to a card in the meantime is refused
        // rather than stripped of a branch its new child is published in.
        await this.publicationGuard.withMembershipLocks(tem, child, async () => ({ validationStoreIds: [] }));
        await this.publicationGuard.refuseACard(tem, child, what);
        tem.remove(found);
        await tem.flush();
        await this.publicationGuard.reconcileParentStores(
          tem,
          child,
          (found.organization as any)?.id ?? (found.organization as any) ?? null,
        );
        return found;
      }),
    );

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT,
        productId,
        Action.UPDATE,
        null,
        `Removed "${(link.product as any).name}" from store "${(link.store as any).name}"`,
        {
          organizationId:
            ((link.product as any).organization as any)?.id ?? ((link.product as any).organization as any) ?? null,
          storeId: (link.store as any).id ?? storeId,
        },
      );
    }
  }

  /**
   * Existence lookup for callers that have ALREADY established tenancy.
   *
   * Every product-images route calls `assertProductInOrganization(em, req.scope,
   * productId)` before reaching its service, so re-deriving the company inside
   * that service would duplicate a boundary rather than add one. This method
   * exists so that fact is stated explicitly at the call site instead of being
   * smuggled in as an omitted argument â€” which is exactly how the old optional
   * `storeScopeId` turned into an unscoped query for every store-less actor.
   *
   * Do NOT call this from a route that has not asserted tenancy first.
   */
  async findByIdAfterTenancyAssertion(id: string): Promise<Product> {
    const product = await this.productRepository.findOne(
      { id },
      { populate: ['categories', 'images', 'stores', 'branchLinks', 'parent', 'children'] },
    );
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async findById(id: string, organizationId: string | null): Promise<Product> {
    if (!organizationId) {
      throw new ForbiddenException(
        'This operation requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    const product = await this.productRepository.findOne(
      // PHASE 4: the company is the boundary. A product of another company
      // behaves as if it did not exist; a SIBLING BRANCH's product resolves
      // normally, because the catalogue is shared.
      { id, organization: organizationId },
      // parent/children: the admin detail page shows the item's family
      { populate: ['categories', 'images', 'stores', 'branchLinks', 'parent', 'children'] },
    );
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  /**
   * Replaces per-store price overrides (ADR 007 P7.3) inside the caller's
   * transaction: a refused override rolls back the whole operation it rode in
   * on â€” product, field values, membership and all.
   *
   * Branch pricing lives ON the assignment (P0-06): an override for a store
   * the product is not assigned to has nothing to attach to, so membership is
   * applied first and this runs after it. The flush below makes the pivots
   * that membership step staged queryable here, still inside the same
   * transaction; the price mutations themselves ride the transaction's
   * closing flush. Overrides not re-sent are cleared back to the base price.
   */
  private async applyStorePrices(tem: EntityManager, product: Product, overrides: StorePriceDto[]): Promise<void> {
    for (const override of overrides) {
      if (override.salePrice !== undefined && override.salePrice !== null && override.salePrice > override.price) {
        throw new BadRequestException('Sale price cannot exceed the regular price (store override)');
      }
    }
    await tem.flush();
    const links = await tem.find(StoreProduct, { product: product.id });
    const byStore = new Map(links.map((link) => [link.store.id, link]));
    for (const override of overrides) {
      const link = byStore.get(override.storeId);
      if (!link) {
        throw new BadRequestException('One or more stores in storePrices do not exist');
      }
      link.price = override.price;
      link.salePrice = override.salePrice ?? null;
    }
    // Links without an override return to the base price
    const overridden = new Set(overrides.map((o) => o.storeId));
    for (const link of links) {
      if (!overridden.has(link.store.id)) {
        link.price = null;
        link.salePrice = null;
      }
    }
  }

  async create(
    dto: CreateProductDto,
    actor?: Actor,
    narrowedStoreId: string | null = null,
    scopedOrganizationId: string | null = null,
  ): Promise<Product> {
    // P0-05: every product belongs to a client. P5-A3: that company is the
    // caller's RESOLVED organization â€” it was `organizationIdOfActor(em, actor)`,
    // which derived tenancy from `actor.store`, i.e. from a user binding. The
    // store fallback below stays for the platform owner creating on a client's
    // behalf, which supplies the company through the named stores.
    const em = this.productRepository.getEntityManager();
    let organizationId = scopedOrganizationId;
    if (!organizationId && dto.storeIds?.length) {
      const firstStore = await em.findOne(Store, { id: dto.storeIds[0] }, { populate: ['organization'] as never });
      organizationId = (firstStore as any)?.organization?.id ?? null;
    }
    if (!organizationId) {
      throw new BadRequestException('A product must belong to an organization â€” assign it to a store');
    }

    // Normalize SKU (convert empty strings/whitespace to null)
    const normalizedSku = dto.sku && dto.sku.trim() !== '' ? dto.sku.trim() : null;
    // The supplier's reference normalizes the same way but is NEVER checked
    // for uniqueness below: it identifies a supplier article, not a product.
    const normalizedManufacturerCode = normalizeManufacturerCode(dto.manufacturerCode);

    // Slugs are system-generated from the name (users don't manage them)
    if (!dto.name?.trim()) {
      throw new BadRequestException('Name is required');
    }
    const { slugify } = await import('../../imports/preview/woocommerce-mapper');
    let autoSlug = slugify(dto.name);
    let slugSuffix = 2;
    // Cap the search: beyond 50 collisions fall back to a time suffix
    while (
      autoSlug &&
      slugSuffix <= 50 &&
      (await this.productRepository.findOne({ slug: autoSlug, organization: organizationId }))
    ) {
      autoSlug = `${slugify(dto.name)}-${slugSuffix++}`;
    }
    if (slugSuffix > 50) {
      autoSlug = `${slugify(dto.name)}-${Date.now().toString(36)}`;
    }

    // Check SKU uniqueness if present
    if (normalizedSku) {
      const existingSku = await this.productRepository.findOne({ sku: normalizedSku, organization: organizationId });
      if (existingSku) {
        throw new ConflictException(`SKU '${normalizedSku}' is already in use`);
      }
    }

    // Check category integrity. categoryId remains the single-category shorthand.
    const newCategoryIds = dto.categoryIds ?? (dto.categoryId ? [dto.categoryId] : []);
    const newCategories: Category[] = [];
    for (const categoryId of newCategoryIds) {
      // Phase 4: same rule as update â€” the product's company, and the acting
      // branch when there is one. P5-A3: the branch is the caller's RESOLVED
      // narrowing, not `actor.store`.
      const category = await this.categoriesService.findAssignableCategory(
        organizationId ?? null,
        narrowedStoreId,
        categoryId,
      );
      if (category.archivedAt) {
        throw new BadRequestException('Cannot assign an archived category to a product');
      }
      // P0-05: a category of another organization behaves as if it did not exist
      const categoryOrgId = (category as any).organization?.id ?? (category as any).organization ?? null;
      if (categoryOrgId && categoryOrgId !== organizationId) {
        throw new NotFoundException(`Category with ID ${categoryId} not found`);
      }
      newCategories.push(category);
    }

    const status = dto.status || ProductStatus.DRAFT;
    if (status === ProductStatus.ARCHIVED) {
      throw new BadRequestException('Archived status can only be set via the archive endpoint');
    }
    const archivedAt = undefined;

    const price = dto.price !== undefined ? dto.price : 0;
    const salePrice = dto.salePrice !== undefined ? dto.salePrice : null;
    const cost = dto.cost !== undefined ? dto.cost : null;
    const stockQuantity = dto.stockQuantity !== undefined ? dto.stockQuantity : 0;
    const trackInventory = dto.trackInventory !== undefined ? dto.trackInventory : false;

    if (price < 0) {
      throw new BadRequestException('Price cannot be negative');
    }
    if (salePrice !== null && salePrice < 0) {
      throw new BadRequestException('Sale price cannot be negative');
    }
    if (cost !== null && cost < 0) {
      throw new BadRequestException('Cost cannot be negative');
    }
    if (stockQuantity < 0) {
      throw new BadRequestException('Stock quantity cannot be negative');
    }

    if (salePrice !== null && salePrice !== undefined && Number(salePrice) > Number(price)) {
      throw new BadRequestException('Sale price cannot exceed the regular price');
    }

    // A NARROWED caller lands its products in the branch it is working in.
    //
    // P5-A2 canonical family 7: that branch used to be `actor.store` â€” the
    // person's own binding, not the branch in context â€” so a manager who had
    // selected one branch created products with no membership at all, while a
    // platform owner managing a company had no default either. The controller
    // now substitutes the RESOLVED branch into `dto.storeIds` before calling,
    // so this method no longer reads the actor for tenancy at all.
    const effectiveStoreIds = dto.storeIds;

    // Everything the product is born as â€” row, field values, membership,
    // publication â€” commits or rolls back as ONE transaction. A widened lock
    // set restarts the whole creation with a fresh entity graph; any other
    // error escapes the callback so the rollback is complete before the
    // caller sees it.
    const organization = organizationId;
    const product = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        const created = tem.create(Product, {
          name: dto.name,
          slug: autoSlug,
          description: dto.description || undefined,
          metaTitle: dto.metaTitle || undefined,
          metaDescription: dto.metaDescription || undefined,
          sku: normalizedSku || undefined,
          manufacturerCode: normalizedManufacturerCode || undefined,
          status,
          saleMode: dto.saleMode,
          organization: organization as any,
          archivedAt,
          price,
          salePrice: salePrice ?? undefined,
          cost: cost ?? undefined,
          trackInventory,
        } as any);
        if (newCategories.length > 0) {
          created.categories.set(newCategories.map((c) => tem.getReference(Category, c.id)));
        }
        // Flushed before the values: the database mints the id they reference.
        await tem.persistAndFlush(created);

        // P5-B3: a product born holding units records them arriving. Creation
        // no longer writes the column â€” the ledger does, and the compatibility
        // value follows from it.
        if (stockQuantity > 0) {
          await this.stock.setProductQuantity(tem as EntityManager, {
            organizationId: organizationId as string,
            productId: created.id,
            targetQuantity: stockQuantity,
            origin: 'product-create',
            actor: actor ? { id: actor.id, email: actor.email } : null,
          });
        }

        // Values BEFORE the publication guard runs, so validation sees the
        // answers this product is being born with.
        await this.productFieldsService.writeCreationValues(
          tem,
          created,
          organization,
          dto.fieldValues ?? [],
          narrowedStoreId,
        );

        if (effectiveStoreIds !== undefined) {
          // At creation every pivot is newly created, so the created set IS
          // the final published set â€” publishingAll would add nothing.
          await this.publicationGuard.applyGuardedPublication(tem, created, organization, {
            storeIds: effectiveStoreIds,
            publishingAll: false,
          });
        }
        if (dto.storePrices !== undefined) {
          await this.applyStorePrices(tem, created, dto.storePrices);
        }
        await tem.flush();
        return created;
      }),
    );

    // `organizationId` is resolved and non-null above (creation refuses without
    // a company), so the re-read stays inside the same tenant.
    const result = await this.findById(product.id, organizationId);

    if (actor && result) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT,
        result.id,
        Action.CREATE,
        null,
        `Created product "${result.name}"`,
        { organizationId },
      );
    }

    return result;
  }

  async update(
    id: string,
    dto: UpdateProductDto,
    organizationId: string | null,
    actor?: { id: string; email: string },
    narrowedStoreId: string | null = null,
  ): Promise<Product> {
    const em = this.productRepository.getEntityManager();
    // PHASE 4: company boundary, not branch. Passed explicitly from the caller's
    // resolved scope so a store-less actor cannot fall through to an unscoped
    // query, which is what `actor?.store ? â€¦ : {}` did.
    const scope = this.organizationScope(organizationId);

    // The whole edit is ONE transaction per attempt. A widened lock set rolls
    // everything back â€” scalar changes included â€” and restarts against a fresh
    // entity graph; any other error escapes the callback so the rollback is
    // complete before the caller sees it.
    const { product, before } = await this.publicationGuard.withLockRetry(() =>
      em.transactional(async (tem) => {
        // READ FROM THE DATABASE, every attempt. This transaction is a fork of
        // the request's entity manager and shares its identity map, and the
        // controller has already read this product into it. Without a
        // refreshing read the product handed back is that earlier read â€” on
        // the first attempt and on every retry â€” so a product released since
        // then is, to every attempt alike, still a child of the card it left,
        // and "start again" starts again with the same stale answer until it
        // gives up.
        //
        // A read of its own, ahead of the populated one: it refreshes the
        // managed entity in place, and the load below then hands that same
        // entity back with its collections.
        //
        // WITHOUT FLUSHING FIRST. An attempt that was rolled back wrote
        // nothing, but the entity it was editing is still in the request's
        // manager with its edits on it, and a read ordinarily flushes what is
        // pending before it queries. That would write the abandoned attempt's
        // edits as this attempt's first statement â€” a row written before any
        // key is held â€” and then read them back as if they had always been
        // there, so the rename that follows would be no change and recorded
        // as none. Read without flushing, the refresh simply overwrites them.
        await tem.findOne(Product, { id }, { refresh: true, flushMode: FlushMode.COMMIT });
        const product = await tem.findOne(Product, { id, ...scope }, { populate: ['categories', 'stores'] });
        if (!product) {
          throw new NotFoundException(`Product with ID ${id} not found`);
        }

        // Reject archived products from modification
        if (product.status === ProductStatus.ARCHIVED || product.archivedAt !== null) {
          throw new BadRequestException('Cannot modify an archived product');
        }

        // WHAT A CARD MAY NOT BE GIVEN (PR C).
        //
        // Decided from the family shape as this transaction sees it, before a
        // single field is assigned. The editor hides these controls, but the
        // interface is not the boundary: this endpoint accepts any of them from
        // any client, and did.
        //
        // `price` is deliberately NOT here. It is the card's sorting key â€” what
        // places it in listings and price filters â€” and nothing else could
        // correct it after a child's price changes. It is never charged.
        const childCount = await tem.count(Product, { parent: product.id });
        if (childCount > 0) {
          const card = { id: product.id, name: product.name, childCount };
          if (dto.stockQuantity !== undefined) assertNotAFamilyCard(card, 'it cannot hold stock');
          if (dto.trackInventory !== undefined) assertNotAFamilyCard(card, 'it cannot track inventory');
          if (dto.salePrice !== undefined) assertNotAFamilyCard(card, 'it is never sold at a sale price');
          if (dto.cost !== undefined) assertNotAFamilyCard(card, 'it is never bought, so it has no cost');
          if (dto.storeIds !== undefined) {
            assertNotAFamilyCard(card, 'its shops are worked out from its child products');
          }
          if (dto.storePrices !== undefined) {
            assertNotAFamilyCard(card, 'a branch cannot set its own price for it');
          }
          // Identity: clearing a legacy value is allowed, stamping a new one
          // is not. Both are compared normalized, so a restatement is a no-op.
          assertIdentityFieldUnchanged('SKU', product.sku ?? null, dto.sku, (raw) => {
            const trimmed = raw === null || raw === undefined ? '' : String(raw).trim();
            return trimmed === '' ? null : trimmed;
          });
          assertIdentityFieldUnchanged(
            'manufacturer code',
            product.manufacturerCode ?? null,
            dto.manufacturerCode,
            normalizeManufacturerCode,
          );
        }

        // THE KEYS, BEFORE THE FIRST WRITE.
        //
        // The publication step further down validates the product as this edit
        // leaves it, so it has to come after the stock posting and the scalar
        // changes â€” but its keys may not. A key taken after the product row
        // has been written is taken in the opposite order to a transaction
        // that holds the key and then writes the row, and the two deadlock.
        const edits = dto.storeIds !== undefined;
        const publishes = dto.status === ProductStatus.PUBLISHED && product.status !== ProductStatus.PUBLISHED;
        const productOrganizationIdForKeys = (product as any).organization?.id ?? (product as any).organization;
        const heldKeys =
          edits || publishes
            ? await this.publicationGuard.lockMembershipEdit(tem, product, productOrganizationIdForKeys, {
                storeIds: dto.storeIds,
                publishingAll: publishes,
              })
            : undefined;
        // The card refusal above was decided from the shape as loaded. Asked
        // again now that the family key is held, where the answer can no longer
        // change: a product promoted to a card in the meantime is refused
        // rather than stripped of a branch its new child is published in.
        if (edits) {
          await this.publicationGuard.refuseACard(tem, product, 'its shops are worked out from its child products');
        }

        const before = {
          name: product.name,
          slug: product.slug,
          sku: product.sku ?? null,
          manufacturerCode: product.manufacturerCode ?? null,
          description: product.description ?? null,
          metaTitle: product.metaTitle ?? null,
          metaDescription: product.metaDescription ?? null,
          price: product.price,
          salePrice: product.salePrice ?? null,
          cost: product.cost ?? null,
          stockQuantity: product.stockQuantity,
          trackInventory: product.trackInventory,
          status: product.status,
          categoryIds: product.categories.getItems().map((c) => c.id),
        };

        // Check slug uniqueness if updated
        // Slug edits ignored: slugs are stable, system-owned identifiers

        // Normalize and check SKU uniqueness if updated
        if (dto.sku !== undefined) {
          const normalizedSku = dto.sku && dto.sku.trim() !== '' ? dto.sku.trim() : null;
          if (normalizedSku && normalizedSku !== product.sku) {
            const productOrgId = (product as any).organization?.id ?? (product as any).organization ?? null;
            const existingSku = await tem.findOne(Product, {
              sku: normalizedSku,
              id: { $ne: id },
              ...(productOrgId ? { organization: productOrgId } : {}),
            });
            if (existingSku) {
              throw new ConflictException(`SKU '${normalizedSku}' is already in use`);
            }
          }
          product.sku = normalizedSku || undefined;
        }

        // The supplier's reference: normalized, never uniqueness-checked.
        // Sending a blank clears it, which is how "we no longer have the
        // supplier's number" is stated.
        if (dto.manufacturerCode !== undefined) {
          product.manufacturerCode = normalizeManufacturerCode(dto.manufacturerCode) || undefined;
        }

        // Check negative validations
        if (dto.price !== undefined && dto.price < 0) {
          throw new BadRequestException('Price cannot be negative');
        }
        if (dto.salePrice !== undefined && dto.salePrice !== null && dto.salePrice < 0) {
          throw new BadRequestException('Sale price cannot be negative');
        }
        if (dto.cost !== undefined && dto.cost !== null && dto.cost < 0) {
          throw new BadRequestException('Cost cannot be negative');
        }
        if (dto.stockQuantity !== undefined && dto.stockQuantity < 0) {
          throw new BadRequestException('Stock quantity cannot be negative');
        }

        // Check pricing validations
        const newPrice = dto.price !== undefined ? dto.price : product.price;
        const newSalePrice = dto.salePrice !== undefined ? dto.salePrice : product.salePrice;

        if (newSalePrice !== undefined && newSalePrice !== null) {
          if (Number(newSalePrice) > Number(newPrice)) {
            throw new BadRequestException('Sale price cannot exceed the regular price');
          }
        }

        if (dto.price !== undefined) {
          product.price = dto.price;
        }
        if (dto.salePrice !== undefined) {
          product.salePrice = dto.salePrice;
        }
        if (dto.cost !== undefined) {
          product.cost = dto.cost;
        }
        // P5-B3: setting a product's quantity is an ADJUSTMENT of the
        // difference against the organization's owned total, posted in this
        // same transaction; the compatibility column follows from the ledger.
        if (dto.stockQuantity !== undefined) {
          await this.stock.setProductQuantity(tem as EntityManager, {
            organizationId: ((product as any).organization?.id ??
              (product as any).organization ??
              organizationId) as string,
            productId: product.id,
            targetQuantity: dto.stockQuantity,
            origin: 'product-edit',
            actor: actor ? { id: actor.id, email: actor.email } : null,
          });
        }
        if (dto.trackInventory !== undefined) {
          product.trackInventory = dto.trackInventory;
        }

        // Check name update
        if (dto.name !== undefined) {
          product.name = dto.name;
        }

        // Check description update
        if (dto.description !== undefined) {
          product.description = dto.description || undefined;
        }

        if (dto.metaTitle !== undefined) {
          product.metaTitle = dto.metaTitle || undefined;
        }

        if (dto.metaDescription !== undefined) {
          product.metaDescription = dto.metaDescription || undefined;
        }

        // Check status update â€” applied BEFORE the publication step, so the
        // guard validates the product as it will actually be after this
        // update. Same transaction either way: a refusal rolls this back too.
        if (dto.status !== undefined) {
          if (dto.status === ProductStatus.ARCHIVED) {
            throw new BadRequestException('Archived status can only be set via the archive endpoint');
          }
          product.status = dto.status;
          product.archivedAt = undefined;
        }
        if (dto.saleMode !== undefined) {
          product.saleMode = dto.saleMode;
        }

        // Moving INTO published state is what turns already-published pivots
        // live, so that transition validates the whole final exposure â€” with
        // or without a membership edit riding the same request.
        const becomesPublished = dto.status === ProductStatus.PUBLISHED && before.status !== ProductStatus.PUBLISHED;
        if (dto.storeIds !== undefined || becomesPublished) {
          const productOrgId = (product as any).organization?.id ?? (product as any).organization;
          await this.publicationGuard.applyGuardedPublication(tem, product, productOrgId, {
            storeIds: dto.storeIds,
            publishingAll: becomesPublished,
            held: heldKeys,
          });
        }

        if (dto.storePrices !== undefined) {
          await this.applyStorePrices(tem, product, dto.storePrices);
        }

        // Every path the item is reachable through. categoryId stays accepted as
        // the single-category shorthand older callers still send.
        const wantedIds =
          dto.categoryIds ?? (dto.categoryId !== undefined ? (dto.categoryId ? [dto.categoryId] : []) : undefined);
        if (wantedIds !== undefined) {
          await product.categories.init();
          const wanted = [];
          const productOrganizationId = (product as any).organization?.id ?? (product as any).organization ?? null;
          for (const id of wantedIds) {
            // Phase 4: resolved under the product's own company AND the acting
            // branch. An organization-wide actor may still use any of the
            // company's categories; a branch actor is held to its own branch
            // plus the company-wide ones.
            const category = await this.categoriesService.findAssignableCategory(
              productOrganizationId,
              narrowedStoreId,
              id,
            );
            if (category.archivedAt) {
              throw new BadRequestException('Cannot assign an archived category to a product');
            }
            // P0-05: a category of another organization behaves as if it did not exist
            const categoryOrgId = (category as any).organization?.id ?? (category as any).organization ?? null;
            if (categoryOrgId && productOrganizationId && categoryOrgId !== productOrganizationId) {
              throw new NotFoundException(`Category with ID ${id} not found`);
            }
            wanted.push(tem.getReference(Category, category.id));
          }
          product.categories.set(wanted);
        }

        await tem.flush();
        return { product, before };
      }),
    );

    if (actor) {
      const changes: Record<string, any> = {};
      if (before.name !== product.name) changes.name = { before: before.name, after: product.name };
      if (before.slug !== product.slug) changes.slug = { before: before.slug, after: product.slug };
      const newSku = product.sku ?? null;
      if (before.sku !== newSku) changes.sku = { before: before.sku, after: newSku };
      const newManufacturerCode = product.manufacturerCode ?? null;
      if (before.manufacturerCode !== newManufacturerCode)
        changes.manufacturerCode = { before: before.manufacturerCode, after: newManufacturerCode };
      const newDesc = product.description ?? null;
      if (before.description !== newDesc) changes.description = { before: before.description, after: newDesc };
      const newMetaTitle = product.metaTitle ?? null;
      if (before.metaTitle !== newMetaTitle) changes.metaTitle = { before: before.metaTitle, after: newMetaTitle };
      const newMetaDescription = product.metaDescription ?? null;
      if (before.metaDescription !== newMetaDescription)
        changes.metaDescription = { before: before.metaDescription, after: newMetaDescription };
      if (before.price !== product.price) changes.price = { before: before.price, after: product.price };
      const currentSalePrice = product.salePrice ?? null;
      if (before.salePrice !== currentSalePrice)
        changes.salePrice = { before: before.salePrice, after: currentSalePrice };
      const currentCost = product.cost ?? null;
      if (before.cost !== currentCost) changes.cost = { before: before.cost, after: currentCost };
      if (before.stockQuantity !== product.stockQuantity)
        changes.stockQuantity = { before: before.stockQuantity, after: product.stockQuantity };
      if (before.trackInventory !== product.trackInventory)
        changes.trackInventory = { before: before.trackInventory, after: product.trackInventory };
      if (before.status !== product.status) changes.status = { before: before.status, after: product.status };
      const currentCatIds = product.categories.getItems().map((c) => c.id);
      if (before.categoryIds.join() !== currentCatIds.join())
        changes.categoryIds = { before: before.categoryIds, after: currentCatIds };

      if (Object.keys(changes).length > 0) {
        await this.auditLogService.recordAuditEntry(
          actor.id,
          actor.email,
          EntityType.PRODUCT,
          product.id,
          Action.UPDATE,
          changes,
          `Updated product "${product.name}"${dto.source === 'builder' ? ' via Builder' : ''}`,
          { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
        );
      }
    }

    return product;
  }

  async archive(
    id: string,
    organizationId: string | null,
    actor?: { id: string; email: string; store?: { id: string } | null },
    bulkActionType?: Action,
  ): Promise<Product> {
    const scope = this.organizationScope(organizationId);
    const product = await this.productRepository.findOne({ id, ...scope });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    const beforeStatus = product.status;
    const beforeArchivedAt = product.archivedAt ?? null;

    product.status = ProductStatus.ARCHIVED;
    product.archivedAt = new Date();
    await this.productRepository.getEntityManager().flush();

    if (actor) {
      const changes = {
        status: { before: beforeStatus, after: product.status },
        archivedAt: { before: beforeArchivedAt, after: product.archivedAt },
      };
      const action = bulkActionType || Action.ARCHIVE;
      const message = bulkActionType ? `Bulk archived product "${product.name}"` : `Archived product "${product.name}"`;
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT,
        product.id,
        action,
        changes,
        message,
        { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
      );
    }

    return product;
  }

  async restore(
    id: string,
    organizationId: string | null,
    actor?: { id: string; email: string; store?: { id: string } | null },
    bulkActionType?: Action,
  ): Promise<Product> {
    const scope = this.organizationScope(organizationId);
    const product = await this.productRepository.findOne({ id, ...scope }, { populate: ['categories'] });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    if (product.archivedAt === null || product.archivedAt === undefined) {
      return product;
    }

    for (const path of product.categories.getItems()) {
      const category = await this.categoryRepository.findOne({ id: path.id });
      if (category && category.archivedAt) {
        throw new BadRequestException('Cannot restore product because its category is archived');
      }
    }

    const beforeStatus = product.status;
    const beforeArchivedAt = product.archivedAt;

    product.archivedAt = undefined;
    product.status = ProductStatus.DRAFT;
    await this.productRepository.getEntityManager().flush();

    if (actor) {
      const changes = {
        status: { before: beforeStatus, after: product.status },
        archivedAt: { before: beforeArchivedAt, after: null },
      };
      const action = bulkActionType || Action.RESTORE;
      const message = bulkActionType ? `Bulk restored product "${product.name}"` : `Restored product "${product.name}"`;
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT,
        product.id,
        action,
        changes,
        message,
        { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
      );
    }

    return product;
  }
}


