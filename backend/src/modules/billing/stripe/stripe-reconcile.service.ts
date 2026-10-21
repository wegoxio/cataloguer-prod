import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import Stripe = require('stripe');
import { Store } from '../../stores/entities/store.entity';
import { StripeService } from './stripe.service';
import { PLAN_BY_LOOKUP_KEY } from './stripe-webhook-transition';
import {
  Classification,
  Finding,
  LocalOrganizationFacts,
  OpenItemFacts,
  StripeSubscriptionFacts,
  classifyOpenItems,
  classifyOrganization,
  classifyOrphanSubscriptions,
  tally,
} from './stripe-reconcile';
import { errorClassification, stripeReconcileRecord } from './stripe-webhook-record';

/**
 * Gathers the facts the reconciliation classifier needs (#248, PR D).
 *
 * Read-only is enforced, not merely intended:
 *  - every database read happens inside one `SET TRANSACTION READ ONLY`, on a
 *    CLEARED fork detached from the request context, so neither a stray write
 *    nor an inherited identity map can turn this into a mutation;
 *  - the only Stripe calls are `subscriptions.list` — the sweep and, when the
 *    sweep truncated, a bounded set of per-customer lookups. No create, update,
 *    delete, expire, or event consumption;
 *  - nothing here writes a ledger row, moves a disposition, settles an attempt
 *    or changes an organization.
 *
 * It is also BOUNDED on BOTH sides. An unbounded report against a shared Stripe
 * account, or against a large database, is a denial of service on ourselves:
 * every database read is capped and time-windowed, Stripe paging is capped, and
 * the response says which cap bit. Where a bound makes an answer unknowable the
 * report says `not_checked` rather than guessing `in_sync`.
 */
export const RECONCILE_BOUNDS = {
  defaultLimit: 50,
  maxLimit: 200,
  /** Subscriptions per Stripe page; Stripe's own maximum. */
  stripePageSize: 100,
  defaultStripePages: 5,
  maxStripePages: 20,
  /** An `open` attempt older than this with no completion is worth a person's attention. */
  stuckOpenAttemptMinutes: 60,
  statementTimeoutMs: 20_000,
  /** Every database read is capped, so a large account cannot be materialised whole. */
  maxRows: 500,
  /** A failed attempt older than this is history, not an open question. */
  attemptWindowDays: 30,
  /** Targeted per-customer lookups, used only when the global sweep truncated. */
  maxCustomerLookups: 50,
} as const;

export interface ReconcileOptions {
  limit?: number;
  maxStripePages?: number;
  requestId: string;
}

/** Why a report is not a complete reconciliation. Closed set. */
export type IncompleteReason =
  | 'stripe_sweep_truncated'
  | 'local_rows_truncated'
  | 'findings_truncated'
  | 'organizations_not_checked';

export interface ReconcileReport {
  generatedAt: string;
  /**
   * The single answer to "is this a complete reconciliation?".
   *
   * The individual bound flags below are diagnostics; this is the verdict, and
   * it exists so a capped or partly-unobserved run can never be READ as a clean
   * bill of health. An empty `findings` list means "nothing found in what was
   * covered" — only `coverage.complete` says whether that was everything.
   */
  coverage: {
    complete: boolean;
    incompleteReasons: IncompleteReason[];
  };
  bounds: {
    limit: number;
    organizationsScanned: number;
    stripeSubscriptionsScanned: number;
    stripePagesRead: number;
    stripeTruncated: boolean;
    localTruncated: boolean;
    customerLookups: number;
    findingsTruncated: boolean;
  };
  counts: Record<Classification, number>;
  findings: Finding[];
}

@Injectable()
export class StripeReconcileService {
  private readonly logger = new Logger(StripeReconcileService.name);

  constructor(
    @InjectRepository(Store) private readonly storeRepository: EntityRepository<Store>,
    private readonly stripeService: StripeService,
  ) {}

  async report(options: ReconcileOptions): Promise<ReconcileReport> {
    const startedAt = Date.now();
    const limit = clamp(options.limit ?? RECONCILE_BOUNDS.defaultLimit, 1, RECONCILE_BOUNDS.maxLimit);
    const maxPages = clamp(
      options.maxStripePages ?? RECONCILE_BOUNDS.defaultStripePages,
      1,
      RECONCILE_BOUNDS.maxStripePages,
    );
    const stripe = this.stripeService.client();
    const fail = (outcome: 'stripe_unavailable' | 'database_unavailable', reason: string, scanned = 0): never => {
      this.logger.warn(
        stripeReconcileRecord({
          requestId: options.requestId,
          outcome,
          reason,
          organizationsScanned: scanned,
          subscriptionsScanned: 0,
          stripePagesRead: 0,
          findings: 0,
          durationMs: Date.now() - startedAt,
        }),
      );
      throw new ServiceUnavailableException(
        outcome === 'stripe_unavailable'
          ? 'The reconciliation report could not reach Stripe. Try again shortly.'
          : 'The reconciliation report could not read the database. Try again shortly.',
      );
    };

    // ── local facts, in ONE read-only transaction on a cleared fork ────────
    // `transactional` flushes the manager's identity map inside the
    // transaction. A fork that inherited request-scoped entities could turn a
    // stray change-set into a write the read-only declaration then refuses,
    // 500ing the report — so the fork is cleared and detached.
    const em = (this.storeRepository.getEntityManager() as EntityManager).fork({ clear: true, useContext: false });
    let local: { organizations: LocalOrganizationFacts[]; open: OpenItemFacts; truncated: boolean };
    try {
      local = await em.transactional(async (tem) => {
        await tem.execute('set transaction read only');
        await tem.execute(`set local statement_timeout = ${RECONCILE_BOUNDS.statementTimeoutMs}`);
        const organizations = await readOrganizations(tem);
        const open = await readOpenItems(tem, RECONCILE_BOUNDS.stuckOpenAttemptMinutes);
        return { organizations, open, truncated: organizations.length >= RECONCILE_BOUNDS.maxRows };
      });
    } catch (error) {
      fail('database_unavailable', errorClassification(error).errorName);
    }

    // ── Stripe facts, read-only and bounded ───────────────────────────────
    let subscriptions: StripeSubscriptionFacts[] = [];
    let pagesRead = 0;
    let stripeTruncated = false;
    try {
      const gathered = await this.sweep(stripe, maxPages);
      subscriptions = gathered.facts;
      pagesRead = gathered.pagesRead;
      stripeTruncated = gathered.truncated;
    } catch (error) {
      // Class only: a Stripe message can quote request data.
      fail('stripe_unavailable', classOf(error), local!.organizations.length);
    }

    const byCustomer = new Map<string, StripeSubscriptionFacts[]>();
    for (const s of subscriptions) {
      if (!s.customerId) continue;
      const list = byCustomer.get(s.customerId) ?? [];
      list.push(s);
      byCustomer.set(s.customerId, list);
    }

    // A truncated sweep proves NOTHING by absence, so for any company whose
    // customer the sweep never returned we ask Stripe about that customer
    // directly. Bounded: beyond the cap a company is reported `not_checked`
    // rather than silently called in sync.
    const observed = new Set(byCustomer.keys());
    let customerLookups = 0;
    if (stripeTruncated) {
      for (const o of local!.organizations) {
        if (!o.customerId || observed.has(o.customerId)) continue;
        if (customerLookups >= RECONCILE_BOUNDS.maxCustomerLookups) break;
        customerLookups += 1;
        try {
          const page = await stripe.subscriptions.list({
            customer: o.customerId,
            status: 'all',
            limit: RECONCILE_BOUNDS.stripePageSize,
          });
          byCustomer.set(
            o.customerId,
            page.data.map((s) => toFacts(s)),
          );
          observed.add(o.customerId);
        } catch {
          // Leave it unobserved; `not_checked` is the honest answer.
        }
      }
    }

    // ── classify (pure) ───────────────────────────────────────────────────
    // Archived companies contribute their customer ids too, so a subscription
    // still being charged is never mistaken for a stranger's.
    const knownCustomerIds = new Set(local!.organizations.map((o) => o.customerId).filter((c): c is string => !!c));
    const slugById = new Map(local!.organizations.map((o) => [o.organizationId, o.slug]));

    const all: Finding[] = [
      ...local!.organizations.map((o) =>
        classifyOrganization(
          o,
          o.customerId ? (byCustomer.get(o.customerId) ?? []) : [],
          !o.customerId || !stripeTruncated || observed.has(o.customerId),
        ),
      ),
      ...classifyOrphanSubscriptions(subscriptions, knownCustomerIds),
      ...classifyOpenItems(local!.open, slugById),
    ];
    // Counts describe EVERYTHING examined; the findings list is what fits.
    const counts = tally(all);
    const actionable = all.filter((f) => f.severity !== 'none');
    const ordered = actionable.sort(rank);
    const findings = ordered.slice(0, limit);

    const incompleteReasons: IncompleteReason[] = [];
    if (stripeTruncated) incompleteReasons.push('stripe_sweep_truncated');
    if (local!.truncated) incompleteReasons.push('local_rows_truncated');
    if (ordered.length > findings.length) incompleteReasons.push('findings_truncated');
    if (counts.not_checked > 0) incompleteReasons.push('organizations_not_checked');

    this.logger.log(
      stripeReconcileRecord({
        requestId: options.requestId,
        outcome: 'ok',
        reason: null,
        organizationsScanned: local!.organizations.length,
        subscriptionsScanned: subscriptions.length,
        stripePagesRead: pagesRead,
        findings: actionable.length,
        durationMs: Date.now() - startedAt,
        coverageComplete: incompleteReasons.length === 0,
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      coverage: { complete: incompleteReasons.length === 0, incompleteReasons },
      bounds: {
        limit,
        organizationsScanned: local!.organizations.length,
        stripeSubscriptionsScanned: subscriptions.length,
        stripePagesRead: pagesRead,
        stripeTruncated,
        localTruncated: local!.truncated,
        customerLookups,
        findingsTruncated: ordered.length > findings.length,
      },
      counts,
      findings,
    };
  }

  /** `subscriptions.list` only, bounded by page count. Nothing here mutates or expands. */
  private async sweep(
    stripe: Stripe,
    maxPages: number,
  ): Promise<{ facts: StripeSubscriptionFacts[]; pagesRead: number; truncated: boolean }> {
    const facts: StripeSubscriptionFacts[] = [];
    let startingAfter: string | undefined;
    let pagesRead = 0;
    let truncated = false;
    for (;;) {
      const page: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list({
        status: 'all',
        limit: RECONCILE_BOUNDS.stripePageSize,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      pagesRead += 1;
      for (const sub of page.data) facts.push(toFacts(sub));
      if (!page.has_more) break;
      if (pagesRead >= maxPages) {
        truncated = true;
        break;
      }
      startingAfter = page.data[page.data.length - 1]?.id;
      if (!startingAfter) {
        // `has_more` with an empty page: we cannot advance, so say so rather
        // than treat what we have as complete.
        truncated = true;
        break;
      }
    }
    return { facts, pagesRead, truncated };
  }
}

/** One subscription, reduced to the four fields the classifier may ever see. */
function toFacts(sub: Stripe.Subscription): StripeSubscriptionFacts {
  const lookupKey = sub.items?.data?.[0]?.price?.lookup_key ?? null;
  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
    status: sub.status,
    planFromPrice: lookupKey ? (PLAN_BY_LOOKUP_KEY[lookupKey] ?? null) : null,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function classOf(error: unknown): string {
  const e = error as { type?: string } | null;
  return e?.type || (error as { constructor?: { name?: string } })?.constructor?.name || 'unknown';
}

/**
 * Deterministic order: actions before info, then by classification, then by
 * identifier. A `Record` rather than an array so the compiler refuses a
 * classification with no rank — an unlisted one would sort ahead of every action.
 */
const ORDER: Record<Classification, number> = {
  unresolved_event: 0,
  attempt_unreconciled: 1,
  subscription_for_archived_organization: 2,
  subscription_missing_locally: 3,
  subscription_missing_at_stripe: 4,
  subscription_not_live: 5,
  plan_mismatch: 6,
  attempt_stuck_open: 7,
  not_checked: 8,
  customer_not_ours: 9,
  organization_without_customer: 10,
  in_sync: 11,
};
function rank(a: Finding, b: Finding): number {
  const d = ORDER[a.classification] - ORDER[b.classification];
  if (d !== 0) return d;
  // Codepoint order, not locale collation: `localeCompare` depends on the
  // runtime's ICU build, which would let two hosts order findings differently
  // and defeat the point of a diffable report.
  const key = (f: Finding) =>
    `${f.organizationId ?? ''}|${f.subscriptionId ?? ''}|${f.eventId ?? ''}|${f.attemptId ?? ''}`;
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

async function readOrganizations(tem: EntityManager): Promise<LocalOrganizationFacts[]> {
  // Archived companies are included: one Stripe is still charging is a
  // disagreement, not foreign traffic. REMOVED companies are not (#294 owner
  // decision 7 of the accepted audit): removal takes a company out of every
  // operational process. Bounded like every read here.
  const rows: any[] = await tem.execute(
    `select id, slug, plan, billing_status, stripe_customer_id, stripe_subscription_id, stripe_previous_subscription_id,
            (archived_at is not null) as archived
       from organizations
      where removed_at is null /* removed_at: a REMOVED company is out of ordinary reconciliation (#294); archived ones stay in */
      order by slug limit ${RECONCILE_BOUNDS.maxRows}`,
  );
  return rows.map((r) => ({
    organizationId: r.id,
    slug: r.slug,
    plan: r.plan,
    billingStatus: r.billing_status,
    customerId: r.stripe_customer_id ?? null,
    subscriptionId: r.stripe_subscription_id ?? null,
    previousSubscriptionId: r.stripe_previous_subscription_id ?? null,
    archived: r.archived === true,
  }));
}

async function readOpenItems(tem: EntityManager, stuckMinutes: number): Promise<OpenItemFacts> {
  const events: any[] = await tem.execute(
    `select event_id, event_type, reason_code, organization_id
       from stripe_events
      where disposition = 'requires_action' and resolved_at is null and livemode = true
      order by first_seen_at
      limit ${RECONCILE_BOUNDS.maxRows}`,
  );
  const unreconciled: any[] = await tem.execute(
    `select id, organization_id, failure_code
       from billing_checkout_attempts
      where status = 'failed' and failure_code is not null
        and created_at > now() - interval '${RECONCILE_BOUNDS.attemptWindowDays} days'
      order by created_at desc
      limit ${RECONCILE_BOUNDS.maxRows}`,
  );
  const stuck: any[] = await tem.execute(
    `select id, organization_id, plan
       from billing_checkout_attempts
      where status in ('creating', 'open') and created_at < now() - (? || ' minutes')::interval
      order by created_at desc
      limit ${RECONCILE_BOUNDS.maxRows}`,
    [String(stuckMinutes)],
  );
  return {
    unresolvedEvents: events.map((e) => ({
      eventId: e.event_id,
      eventType: e.event_type,
      reasonCode: e.reason_code,
      organizationId: e.organization_id ?? null,
    })),
    unreconciledAttempts: unreconciled.map((a) => ({
      attemptId: a.id,
      organizationId: a.organization_id,
      failureCode: a.failure_code ?? null,
    })),
    stuckOpenAttempts: stuck.map((a) => ({ attemptId: a.id, organizationId: a.organization_id, plan: a.plan })),
  };
}
