import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@mikro-orm/nestjs';
import { LockMode } from '@mikro-orm/core';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import Stripe = require('stripe');
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Payment } from '../entities/payment.entity';
import { effectivePlanPriceUsd, isComplimentaryPlan, PLANS } from '../../stores/plans';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { EntityType, Action } from '../../audit-log/entities/audit-log.entity';
import { OrganizationPlanPolicy } from '../plans/organization-plan-policy';
import {
  errorClassification,
  stripeEventReapplied,
  stripeEventReapplyFailed,
  stripeObjectId,
  stripeWebhookDeliveryRecordFailed,
  stripeWebhookFailed,
  stripeWebhookRecord,
  stripeWebhookRejected,
  stripeWebhookRequiresAction,
  stripeCheckoutAttempt,
  stripeCheckoutRequiresAction,
  CheckoutAttemptOutcome,
  WebhookOutcome,
} from './stripe-webhook-record';
import {
  CheckoutAttempt,
  findAttemptBySession,
  findAttemptById,
  findOpenAttempt,
  freezeAttemptRequest,
  insertCreatingAttempt,
  claimReissue,
  markAttemptOpen,
  settleAttempt,
} from './checkout-attempts';
import {
  decide,
  Decision,
  EventFacts,
  LocalFacts,
  LocalOrganization,
  PLAN_BY_LOOKUP_KEY,
  PlanCheck,
  retrievalRequired,
  RetrievedSubscription,
  SessionFacts,
} from './stripe-webhook-transition';
import {
  claimEvent,
  EventIdentity,
  ExistingEvent,
  findExistingEvent,
  finalizeEvent,
  insertDelivery,
  insertProcessing,
  invoiceAlreadyRecorded,
  lockEventForReapply,
  lockObject,
  objectAlreadyApplied,
  recordRedelivery,
  resolveEvent,
} from './stripe-event-ledger';

/** Plan key -> Stripe price lookup key. Only card-purchasable plans; never a complimentary one. */
export const PLAN_LOOKUP: Record<string, string> = {
  BASICO: 'basico',
  CRECIMIENTO: 'crecimiento',
  MULTIMARCA: 'multimarca',
};

const COMPLIMENTARY_CHECKOUT =
  'This company is on a complimentary plan that is never billed; only the platform owner can change its plan';

/** Who asked for the checkout (#248 PR C): recorded on the attempt and on a settlement. */
export interface CheckoutActor {
  id: string | null;
  email: string | null;
}

type CheckoutStep =
  | { kind: 'portal' }
  | { kind: 'create'; attempt: CheckoutAttempt }
  | { kind: 'reissue'; attempt: CheckoutAttempt }
  | { kind: 'join'; attempt: CheckoutAttempt }
  | { kind: 'settle'; attempt: CheckoutAttempt };

/** A `creating` attempt older than this was abandoned by a request that died; re-issue it. */
const STALE_CREATING_MS = 30_000;
/** How long a concurrent caller waits for the in-flight attempt's URL (D-9). */
const JOIN_WAIT_MS = 8_000;
const JOIN_POLL_MS = 250;
const MAX_CHECKOUT_ROUNDS = 3;
const MAX_EVENT_SCAN = 500;

/** Raised inside the settle path; the caller records it and answers 503. Carries a code, never a message. */
class StripeUnavailable extends Error {
  constructor(readonly code: string) {
    super('stripe unavailable');
  }
}

/** User-facing texts: no identifiers, no Stripe wording. */
const CHECKOUT_MESSAGES = {
  portal: 'This company already has a card subscription. Manage it in the payment portal.',
  requires_action: 'Checkout needs a review before it can continue. Please contact support.',
  unavailable: 'Checkout is temporarily unavailable. Please try again in a moment.',
};

/**
 * Whether Stripe gave a DEFINITE refusal (the operation did not happen) or the
 * outcome is unknown (the request may have reached Stripe). Only the class
 * name and code are kept; messages quote values.
 */
export function classifyStripeFailure(error: unknown): { code: string; definite: boolean } {
  const e = error as { type?: string; code?: string; statusCode?: number } | null;
  const type = e?.type ?? '';
  if (e?.code === 'resource_missing' || e?.statusCode === 404) return { code: 'resource_missing', definite: true };
  if (type === 'StripeConnectionError' || type === 'StripeAPIError' || (e?.statusCode ?? 0) >= 500) {
    return { code: type || 'stripe_unavailable', definite: false };
  }
  if (type === 'StripeRateLimitError') return { code: type, definite: false };
  // 409 `idempotency_key_in_use`: another request is mid-flight under the same
  // key — the outcome is theirs, not a refusal. 400: the params differ — definite.
  if (type === 'StripeIdempotencyError') return { code: type, definite: e?.statusCode !== 409 };
  if (
    type === 'StripeInvalidRequestError' ||
    type === 'StripeCardError' ||
    type === 'StripeAuthenticationError' ||
    type === 'StripePermissionError'
  ) {
    return { code: type, definite: true };
  }
  return { code: 'unknown', definite: false };
}

const KNOWN_PLANS: ReadonlySet<string> = new Set(Object.keys(PLANS));

/** Correlation carried from the HTTP layer; the handler never reads the request itself. */
export interface WebhookContext {
  requestId?: string;
}

interface InvoiceFacts {
  id: string;
  number: string | null;
  hostedInvoiceUrl: string | null;
  amountPaid: number;
  created: number | null;
}

interface ParsedEvent {
  facts: EventFacts;
  identity: Omit<EventIdentity, 'organizationId'>;
  invoice: InvoiceFacts | null;
}

interface LocalRead {
  organization: Organization | null;
  local: LocalFacts;
  /** The facts a concurrent commit could change; compared before and after locking. */
  relationKey: string;
}

type Actor = { id: string | null; email: string | null };

type PhaseOneResult = { kind: 'lost_race' } | { kind: 'done'; decision: Decision; organizationId: string | null };

type ReapplyPhaseOneResult =
  | { kind: 'already_resolved' }
  | { kind: 'no_change'; reason: string }
  | { kind: 'resolved'; result: 'applied' | 'ignored'; reason: string };

export type ReapplyOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_resolved' }
  | { kind: 'no_change'; reason: string }
  | { kind: 'resolved'; result: 'applied' | 'ignored'; reason: string };

/** Thrown inside phase one to roll the claim back and recompute from phase zero. */
class RestartFromPhaseZero extends Error {}

/**
 * What leaves the handler after a failure has been RECORDED. Nest's default
 * exception handler logs the message and stack of any non-HTTP error; driver
 * and Stripe messages quote values, so they must not reach it. The HTTP
 * status stays 5xx (Stripe retries); an HTTP exception of our own (400s)
 * passes through unchanged.
 */
function opaqueFailure(error: unknown): Error {
  if (error instanceof HttpException) return error;
  return new InternalServerErrorException('Stripe webhook processing failed');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `metadata.organizationId` as Stripe hands it back. Our own sessions write a
 * UUID; on the shared account anything may appear. A malformed value is a
 * FACT the transition table can rule on (`unknown_organization`), never a
 * query parameter that fails with the value quoted in the driver message.
 */
function organizationIdFromMetadata(value: unknown): { id: string | null; malformed: boolean } {
  if (typeof value !== 'string' || value.length === 0) return { id: null, malformed: false };
  return UUID.test(value) ? { id: value, malformed: false } : { id: null, malformed: true };
}

const MAX_PHASE_ZERO_RESTARTS = 1;

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  /** Checkout waits (#248 PR C). Tests shorten them; production runs the defaults. */
  static checkoutTiming = { staleCreatingMs: STALE_CREATING_MS, joinWaitMs: JOIN_WAIT_MS, joinPollMs: JOIN_POLL_MS };

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Store)
    private readonly storeRepository: EntityRepository<Store>,
    private readonly auditLogService: AuditLogService,
  ) {
    const key = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key) : null;
  }

  private require(): Stripe {
    if (!this.stripe) throw new BadRequestException('Card payments are not configured yet');
    return this.stripe;
  }

  /**
   * The configured Stripe client, for READ-ONLY collaborators (#248, PR D's
   * reconciliation report). It is the same client the write paths use; what
   * makes a caller read-only is which methods it calls, which that module's
   * tests pin against a fake that throws on every mutating method.
   */
  client(): Stripe {
    return this.require();
  }

  /**
   * The client being billed (P5-A2 family 3, D-4).
   *
   * The three subscription operations used to be addressed by a STORE id and
   * resolve the company from it, which made a branch look like the billing
   * identity. The organization is now named directly. The legacy `storeId`
   * session metadata is no longer resolved (#248 PRB-D3): the two sessions
   * that ever carried it expired in July 2026, and `stores` holds no Stripe
   * columns any more.
   */
  private async requireOrganization(organizationId: string): Promise<Organization> {
    const em = this.storeRepository.getEntityManager();
    const organization = await em.findOne(Organization, { id: organizationId });
    if (!organization) throw new BadRequestException('Organization not found');
    return organization;
  }

  /** Hosted Checkout for the actor's ORGANIZATION and chosen plan (P0-09). */
  /**
   * Hosted Checkout for the company (#248, PR C): one durable ATTEMPT per
   * checkout operation, so two clicks are one session and a request that dies
   * half-way is finished by the next one.
   *
   * Stripe is never called inside a transaction. The sequence is: the price
   * (read), the customer (search by our organization id, else create under the
   * key `customer:<organizationId>`), then one short transaction under the
   * organization's lock that refuses when a subscription already exists
   * (D-5: the portal is the answer), validates plan capacity, and either
   * records a new `creating` attempt with the exact Stripe call frozen, or
   * names the attempt still in flight. Outside the transaction: a new attempt
   * calls Stripe under the key `checkout:<attemptId>`; a `creating` attempt
   * younger than the stale threshold is JOINED (the caller waits briefly for
   * its URL, D-9) and an older one is re-issued under the same key, which
   * makes Stripe return the same session; an `open` attempt is settled against
   * Stripe's view — reused while open, replaced when expired, and when it
   * COMPLETED without its webhook the completed event is found and applied
   * through the ledger (trigger `settlement`), which ends in the portal answer.
   * A live subscription the ledger never saw refuses checkout with a
   * `requires_action` record rather than selling a second one.
   */
  async createCheckout(
    organizationId: string,
    planKey: string,
    actor: CheckoutActor,
    context: { requestId?: string } = {},
  ): Promise<string> {
    const requestId = context.requestId ?? randomUUID();
    const startedAt = Date.now();
    const em = this.storeRepository.getEntityManager();
    const lookup = PLAN_LOOKUP[planKey];
    if (!lookup) throw new BadRequestException(`Plan ${planKey} cannot be paid by card`);
    const organization = await this.requireOrganization(organizationId);
    // Plan Gratis, before ANY Stripe call: no price read, no customer created,
    // no attempt recorded. Moving a company off it is the platform owner's
    // decision, never a checkout a tenant can start.
    if (isComplimentaryPlan(organization.plan)) throw new BadRequestException(COMPLIMENTARY_CHECKOUT);
    // Only now is card payment's configuration consulted: a complimentary
    // company is told the truth even where card payments are not configured.
    const stripe = this.require();
    if (effectivePlanPriceUsd(PLANS[planKey], organization) === 0) {
      throw new BadRequestException('This organization has a complimentary plan and does not need card checkout');
    }
    const record = (
      outcome: CheckoutAttemptOutcome,
      attemptId: string | null,
      sessionId: string | null,
      reason: string | null,
    ) =>
      this.logger.log(
        stripeCheckoutAttempt({
          requestId,
          organizationId,
          attemptId,
          sessionId,
          outcome,
          reason,
          durationMs: Date.now() - startedAt,
        }),
      );
    const requiresAction = (attemptId: string | null, reason: string): ConflictException => {
      this.logger.warn(stripeCheckoutRequiresAction({ requestId, organizationId, attemptId, reason }));
      record('refused', attemptId, null, reason);
      return new ConflictException({ statusCode: 409, message: CHECKOUT_MESSAGES.requires_action, reason });
    };
    const portal = (): ConflictException => {
      record('refused', null, null, 'portal');
      return new ConflictException({ statusCode: 409, message: CHECKOUT_MESSAGES.portal, reason: 'portal' });
    };
    const unavailable = (attemptId: string | null, reason: string, outcome: 'unavailable' | 'failed') => {
      record(outcome, attemptId, null, reason);
      return new ServiceUnavailableException(CHECKOUT_MESSAGES.unavailable);
    };

    // D-5, before any Stripe call: a company with a subscription manages it in the portal.
    if (organization.stripeSubscriptionId) throw portal();

    // ── the only Stripe call before the gate: a side-effect-free price read ──
    // (#318) Nothing that creates, attaches or records anything happens before
    // this request has WON under the organization-plan lock, below.
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const priceIds = new Map<string, string>();
    const priceFor = async (plan: string): Promise<string> => {
      const known = priceIds.get(plan);
      if (known) return known;
      const prices = await stripe.prices.list({ lookup_keys: [PLAN_LOOKUP[plan]], limit: 1 });
      if (!prices.data.length) throw new BadRequestException('Price not found in Stripe');
      priceIds.set(plan, prices.data[0].id);
      return prices.data[0].id;
    };
    try {
      await priceFor(planKey);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw unavailable(null, classifyStripeFailure(error).code, 'unavailable');
    }
    // The exact session request, frozen onto the attempt once its customer is known.
    const sessionRequest = (
      attempt: CheckoutAttempt,
      customerId: string,
      priceId: string,
    ): Stripe.Checkout.SessionCreateParams => ({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/dashboard/billing?paid=1`,
      cancel_url: `${base}/dashboard/billing`,
      // organizationId is the identity; attemptId ties the session to this operation.
      metadata: { organizationId, plan: attempt.plan, attemptId: attempt.id },
      subscription_data: { metadata: { organizationId, plan: attempt.plan } },
    });

    for (let round = 0; round < MAX_CHECKOUT_ROUNDS; round++) {
      // ── one short transaction under the organization's lock ─────────────
      const step = await em.transactional<CheckoutStep>(async (tem) => {
        await OrganizationPlanPolicy.requireOrganization(tem, organizationId);
        await OrganizationPlanPolicy.lock(tem, organizationId);
        const locked = await tem.findOne(
          Organization,
          { id: organizationId },
          { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
        );
        if (!locked) throw new BadRequestException('Organization not found');
        if (locked.stripeSubscriptionId) return { kind: 'portal' };
        // THE GATE (#318). Under the organization-plan lock and the company row
        // lock — the pair every plan writer takes — the company is re-read. A
        // Plan Gratis assignment that committed first is seen here and refused:
        // no attempt, no customer, no session. If this request wins, it commits
        // its `creating` attempt BEFORE any side-effecting Stripe call, and a
        // Plan Gratis assignment arriving later sees that attempt and is refused.
        if (isComplimentaryPlan(locked.plan)) throw new BadRequestException(COMPLIMENTARY_CHECKOUT);
        await OrganizationPlanPolicy.assertPlanChange(tem, locked, PLANS[planKey]);
        const open = await findOpenAttempt(tem, organizationId);
        if (!open) {
          const attempt = await insertCreatingAttempt(tem, {
            organizationId,
            plan: planKey,
            createdByUserId: actor.id,
          });
          return { kind: 'create', attempt };
        }
        if (open.status === 'open') return { kind: 'settle', attempt: open };
        // Age from the last movement: a re-issue claim bumps it, so concurrent
        // callers join the one request that is re-issuing instead of racing it.
        const ageMs = Date.now() - open.updatedAt.getTime();
        if (
          ageMs >= StripeService.checkoutTiming.staleCreatingMs &&
          (await claimReissue(tem, organizationId, open.id))
        ) {
          return { kind: 'reissue', attempt: open };
        }
        return { kind: 'join', attempt: open };
      });

      if (step.kind === 'portal') throw portal();

      // Everything after the transaction talks to Stripe. A failure that is not
      // already an HTTP answer is recorded (class only) and answered 503; the
      // message never reaches Nest's default handler (it may quote values).
      const stepAttemptId = step.attempt.id;
      try {
        if (step.kind === 'join') {
          const joined = await this.waitForAttempt(em, organizationId, step.attempt.id);
          if (joined?.status === 'open' && joined.sessionUrl) {
            // Another plan was asked for: the next round settles this session —
            // expired at Stripe and replaced — rather than handing out its page.
            if (joined.plan !== planKey) continue;
            record('joined', joined.id, joined.stripeSessionId, null);
            return joined.sessionUrl;
          }
          throw unavailable(step.attempt.id, 'checkout_in_progress', 'unavailable');
        }

        if (step.kind === 'create' || step.kind === 'reissue') {
          // Checkout WON (#318): its attempt is committed, the lock is released,
          // and only now are side-effecting Stripe calls made. No database lock
          // is held across any of them.
          let attempt = step.attempt;
          if (!attempt.requestParams || !attempt.stripeCustomerId) {
            let customer: { kind: 'ok'; id: string } | { kind: 'ambiguous' };
            let priceId: string;
            try {
              priceId = await priceFor(attempt.plan);
              customer = await this.resolveCustomer(stripe, em, organization, actor.email);
            } catch (error) {
              if (error instanceof HttpException) {
                await settleAttempt(em, organizationId, attempt.id, {
                  status: 'failed',
                  failureCode: 'price_not_found',
                });
                throw error;
              }
              const failure = classifyStripeFailure(error);
              // A definite refusal ends the attempt truthfully; an unknown outcome
              // keeps it `creating`, re-issued later under the same idempotency keys.
              if (failure.definite) {
                await settleAttempt(em, organizationId, attempt.id, { status: 'failed', failureCode: failure.code });
              }
              throw unavailable(attempt.id, failure.code, failure.definite ? 'failed' : 'unavailable');
            }
            if (customer.kind === 'ambiguous') {
              await settleAttempt(em, organizationId, attempt.id, {
                status: 'failed',
                failureCode: 'ambiguous_customer',
              });
              throw requiresAction(attempt.id, 'ambiguous_customer');
            }
            const frozen = await freezeAttemptRequest(
              em,
              organizationId,
              attempt.id,
              customer.id,
              sessionRequest(attempt, customer.id, priceId) as unknown as Record<string, unknown>,
            );
            if (!frozen || frozen.status !== 'creating' || !frozen.requestParams || !frozen.stripeCustomerId) {
              throw unavailable(attempt.id, 'attempt_moved', 'unavailable');
            }
            attempt = frozen;
          }
          const customerId = attempt.stripeCustomerId as string;
          // A live subscription the ledger never saw: never sell a second one.
          // Evaluated for a re-issue too — the first request may have died
          // before it could ask.
          let live: number;
          try {
            live = await this.liveSubscriptionCount(stripe, customerId);
          } catch (error) {
            throw unavailable(attempt.id, classifyStripeFailure(error).code, 'unavailable');
          }
          if (live > 0) {
            await settleAttempt(em, organizationId, attempt.id, { status: 'failed', failureCode: 'unreconciled' });
            throw requiresAction(attempt.id, live > 1 ? 'multiple_live_subscriptions' : 'subscription_unreconciled');
          }
          let session: Stripe.Checkout.Session;
          try {
            session = await stripe.checkout.sessions.create(
              attempt.requestParams as unknown as Stripe.Checkout.SessionCreateParams,
              { idempotencyKey: attempt.stripeIdempotencyKey },
            );
          } catch (error) {
            const failure = classifyStripeFailure(error);
            // A definite refusal ends the attempt; an unknown outcome (the request
            // may have reached Stripe) keeps it `creating` so the next request
            // re-issues the same call under the same key.
            if (failure.definite) {
              await settleAttempt(em, organizationId, attempt.id, { status: 'failed', failureCode: failure.code });
            }
            throw unavailable(attempt.id, failure.code, failure.definite ? 'failed' : 'unavailable');
          }
          if (!session.url) {
            await settleAttempt(em, organizationId, attempt.id, { status: 'failed', failureCode: 'no_url' });
            throw unavailable(attempt.id, 'no_url', 'failed');
          }
          const opened = await markAttemptOpen(em, organizationId, attempt.id, {
            id: session.id,
            url: session.url,
            expiresAt: typeof session.expires_at === 'number' ? new Date(session.expires_at * 1000) : null,
          });
          if (!opened) {
            // The row moved while Stripe was answering. A URL is handed out only
            // on a row that vouches for it: if a concurrent request opened this
            // same session, that is the answer; otherwise the session is closed
            // at Stripe so nothing payable exists that no row knows about.
            const current = await findAttemptById(em, organizationId, attempt.id);
            if (current?.status === 'open' && current.stripeSessionId === session.id && current.sessionUrl) {
              record('joined', current.id, current.stripeSessionId, null);
              return current.sessionUrl;
            }
            await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
            throw unavailable(attempt.id, 'attempt_moved', 'unavailable');
          }
          if (attempt.plan !== planKey) {
            // A re-issued attempt for another plan: recorded, then settled by the
            // next round (expired at Stripe and replaced), never handed out.
            record('reissued', attempt.id, session.id, 'plan_differs');
            continue;
          }
          record(step.kind === 'create' ? 'created' : 'reissued', attempt.id, session.id, null);
          return session.url;
        }

        // ── settle the open attempt against Stripe's view ───────────────────
        const settled = await this.settleOpenAttempt(stripe, em, step.attempt, planKey, actor, requestId);
        if (settled.kind === 'reuse') {
          record('reused', step.attempt.id, step.attempt.stripeSessionId, null);
          return settled.url;
        }
        if (settled.kind === 'expired') {
          record('settled_expired', step.attempt.id, step.attempt.stripeSessionId, settled.reason);
          continue;
        }
        if (settled.kind === 'completed_unresolved') throw requiresAction(step.attempt.id, settled.reason);
        record('settled_completed', step.attempt.id, step.attempt.stripeSessionId, settled.reason);
        // `completed_applied`: the next round finds the subscription and answers
        // with the portal; a decision that applied nothing lets a new attempt start.
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (error instanceof StripeUnavailable) throw unavailable(stepAttemptId, error.code, 'unavailable');
        throw unavailable(stepAttemptId, errorClassification(error).errorName, 'unavailable');
      }
    }
    throw unavailable(null, 'rounds_exhausted', 'unavailable');
  }

  /**
   * The company's Stripe customer. An existing id is used as is. Otherwise a
   * customer created earlier whose write was lost is ADOPTED by searching for
   * our organization id in its metadata (exactly one); more than one is a
   * question for a person. Creation carries the key `customer:<organizationId>`
   * so a retried create cannot make a second customer. The id is written with a
   * conditional update: if a concurrent request won, its id stands.
   */
  private async resolveCustomer(
    stripe: Stripe,
    em: EntityManager,
    organization: Organization,
    email: string | null,
  ): Promise<{ kind: 'ok'; id: string } | { kind: 'ambiguous' }> {
    if (organization.stripeCustomerId) return { kind: 'ok', id: organization.stripeCustomerId };
    const found = await stripe.customers.search({
      query: `metadata['organizationId']:'${organization.id}'`,
      limit: 2,
    });
    const candidates = found.data.filter((c) => !(c as { deleted?: boolean }).deleted);
    if (candidates.length > 1) return { kind: 'ambiguous' };
    let id: string;
    if (candidates.length === 1) {
      id = candidates[0].id;
    } else {
      // The payload under the key never depends on who clicked: a retry by
      // another manager must be the same request. The email is added after.
      const customer = await stripe.customers.create(
        { name: organization.name, metadata: { organizationId: organization.id } },
        { idempotencyKey: `customer:${organization.id}` },
      );
      id = customer.id;
      if (email) await stripe.customers.update(id, { email }).catch(() => undefined);
    }
    await em.execute(
      `update organizations set stripe_customer_id = ?, updated_at = now()
        where id = ?::uuid and stripe_customer_id is null
          and removed_at is null /* removed_at: never a billing write under a removed company (#294) */`,
      [id, organization.id],
    );
    const [row]: { c: string }[] = await em.execute(
      `select stripe_customer_id as c from organizations where id = ?::uuid /* removed_at: read-back of the write above, by id */`,
      [organization.id],
    );
    organization.stripeCustomerId = row.c;
    return { kind: 'ok', id: row.c };
  }

  /** Live (`active`/`trialing`) subscriptions Stripe holds for the customer. */
  private async liveSubscriptionCount(stripe: Stripe, customerId: string): Promise<number> {
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return list.data.filter((sub) => sub.status === 'active' || sub.status === 'trialing').length;
  }

  /** Joins an attempt another request is creating: a short wait for its URL (D-9). */
  private async waitForAttempt(
    em: EntityManager,
    organizationId: string,
    attemptId: string,
  ): Promise<CheckoutAttempt | null> {
    const deadline = Date.now() + StripeService.checkoutTiming.joinWaitMs;
    for (;;) {
      const attempt = await findAttemptById(em, organizationId, attemptId);
      if (!attempt || attempt.status !== 'creating' || Date.now() >= deadline) return attempt;
      await new Promise((resolve) => setTimeout(resolve, StripeService.checkoutTiming.joinPollMs));
    }
  }

  /**
   * Stripe's view of an `open` attempt's session. `open` and unexpired for the
   * same plan → reuse; a different plan → the old session is expired at Stripe
   * and replaced; `expired` (or gone) → replaced; `complete` → the completed
   * event is found in Stripe's event list and applied through the ledger as a
   * `settlement`, exactly as its webhook would have been.
   */
  private async settleOpenAttempt(
    stripe: Stripe,
    em: EntityManager,
    attempt: CheckoutAttempt,
    planKey: string,
    actor: CheckoutActor,
    requestId: string,
  ): Promise<
    | { kind: 'reuse'; url: string }
    | { kind: 'expired'; reason: string }
    | { kind: 'completed_applied'; reason: string }
    | { kind: 'completed_unresolved'; reason: string }
  > {
    const sessionId = attempt.stripeSessionId as string;
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (error) {
      const failure = classifyStripeFailure(error);
      if (failure.code !== 'resource_missing') throw new StripeUnavailable(failure.code);
      await settleAttempt(em, attempt.organizationId, attempt.id, { status: 'expired', settleNote: 'session_missing' });
      return { kind: 'expired', reason: 'session_missing' };
    }
    if (session.status === 'open') {
      const expired = typeof session.expires_at === 'number' && session.expires_at * 1000 <= Date.now();
      if (!expired && attempt.plan === planKey) {
        const url = session.url ?? attempt.sessionUrl;
        if (url) return { kind: 'reuse', url };
      }
      if (!expired) {
        try {
          await stripe.checkout.sessions.expire(sessionId);
        } catch (error) {
          throw new StripeUnavailable(classifyStripeFailure(error).code);
        }
      }
      const reason = expired ? 'expired' : 'replaced_plan_change';
      await settleAttempt(em, attempt.organizationId, attempt.id, { status: 'expired', settleNote: reason });
      return { kind: 'expired', reason };
    }
    if (session.status === 'expired') {
      await settleAttempt(em, attempt.organizationId, attempt.id, { status: 'expired', settleNote: 'expired' });
      return { kind: 'expired', reason: 'expired' };
    }
    // complete
    if (!session.subscription || session.payment_status !== 'paid') {
      await settleAttempt(em, attempt.organizationId, attempt.id, {
        status: 'completed',
        completedEventId: null,
        settleNote: 'complete_unpaid',
      });
      return { kind: 'completed_unresolved', reason: 'completed_session_unpaid' };
    }
    const event = await this.findCompletedEvent(stripe, sessionId, attempt.createdAt);
    if (!event) {
      await settleAttempt(em, attempt.organizationId, attempt.id, {
        status: 'completed',
        completedEventId: null,
        settleNote: 'event_not_found',
      });
      return { kind: 'completed_unresolved', reason: 'completed_session_event_not_found' };
    }
    const applied = await this.applyVerifiedEvent(stripe, em, event, parseEvent(event), requestId, {
      trigger: 'settlement',
      actor,
    });
    // The transaction that applied the event settled the attempt; a duplicate
    // (the webhook won after all) leaves it settled already. Either way the
    // row is terminal now, with the event id when this call recorded it.
    await settleAttempt(em, attempt.organizationId, attempt.id, {
      status: 'completed',
      completedEventId: event.id,
      settleNote: 'settled_by_retrieval',
    });
    if (applied.outcome.disposition === 'requires_action') {
      this.logger.warn(
        stripeWebhookRequiresAction({
          requestId,
          eventId: event.id,
          eventType: event.type,
          objectId: sessionId,
          organizationId: attempt.organizationId,
          reason: applied.outcome.reason,
        }),
      );
      return { kind: 'completed_unresolved', reason: `completed_session_${applied.outcome.reason}` };
    }
    return { kind: 'completed_applied', reason: applied.outcome.reason };
  }

  /** The `checkout.session.completed` event for a session, from Stripe's event list (30-day retention). */
  private async findCompletedEvent(stripe: Stripe, sessionId: string, since: Date): Promise<Stripe.Event | null> {
    let scanned = 0;
    for await (const event of stripe.events.list({
      type: 'checkout.session.completed',
      created: { gte: Math.floor(since.getTime() / 1000) - 60 },
      limit: 100,
    })) {
      const object = event.data?.object as { id?: unknown } | undefined;
      if (object?.id === sessionId) return event;
      if (++scanned >= MAX_EVENT_SCAN) break;
    }
    return null;
  }

  async createPortal(organizationId: string): Promise<string> {
    const stripe = this.require();
    const organization = await this.requireOrganization(organizationId);
    if (!organization.stripeCustomerId) throw new BadRequestException('No card subscription for this company yet');
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const session = await stripe.billingPortal.sessions.create({
      customer: organization.stripeCustomerId,
      return_url: `${base}/dashboard/billing`,
    });
    return session.url;
  }

  /** Next charge + card summary for the Billing page. */
  async getStripeInfo(organizationId: string) {
    const stripe = this.require();
    const organization = await this.requireOrganization(organizationId);
    if (!organization.stripeSubscriptionId) return { active: false };
    try {
      const sub = await stripe.subscriptions.retrieve(organization.stripeSubscriptionId, {
        expand: ['default_payment_method'],
      });
      const pm = sub.default_payment_method as Stripe.PaymentMethod | null;
      const item = sub.items?.data?.[0];
      return {
        active: sub.status === 'active' || sub.status === 'trialing',
        status: sub.status,
        nextChargeAt: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
        cardLast4: pm?.card?.last4 ?? null,
      };
    } catch {
      return { active: false };
    }
  }

  // ───────────────────────── webhook ─────────────────────────

  /**
   * Verifies the signature and applies the event (#248, PR B).
   *
   * Phase 0 (no transaction, no locks): parse; the duplicate FAST PATH — a
   * committed ledger row settles the delivery without contacting Stripe or
   * re-evaluating anything; a plain read of the organization; the Stripe
   * retrieval the transition table requires, if any.
   * Phase 1 (one transaction): claim the event with INSERT … ON CONFLICT DO
   * NOTHING; lock the object, the organization (advisory) and the organization
   * row; re-read; confirm the retrieved object still corresponds; recompute the
   * transition from the state that is about to change; apply, with a strict
   * audit entry; finalise the disposition; commit. A lost claim race is a
   * duplicate. If a concurrent commit changed the facts between phases, the
   * transaction rolls back (taking the claim with it) and phase 0 runs again
   * once.
   * Phase 2 (own transaction): the delivery record. Its failure never undoes
   * the committed effect: it is logged, the delivery answers 500, and Stripe's
   * retry takes the fast path.
   */
  async handleWebhook(rawBody: Buffer, signature: string, context: WebhookContext = {}): Promise<void> {
    // Always an identifier of our own: the delivery table keys on it.
    const requestId = context.requestId ?? randomUUID();
    const receivedAt = new Date();
    const startedAt = Date.now();

    let stripe: Stripe;
    try {
      stripe = this.require();
    } catch (error) {
      this.logger.warn(stripeWebhookRejected(requestId, 'not_configured'));
      throw error;
    }
    const secret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn(stripeWebhookRejected(requestId, 'not_configured'));
      throw new BadRequestException('Webhook not configured');
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      this.logger.warn(stripeWebhookRejected(requestId, 'invalid_signature'));
      throw new BadRequestException('Invalid webhook signature');
    }

    const objectId = stripeObjectId(event);
    const parsed = parseEvent(event);
    const em = this.storeRepository.getEntityManager();
    const finish = (outcome: WebhookOutcome) =>
      this.logger.log(stripeWebhookRecord({ requestId, event, objectId, outcome, durationMs: Date.now() - startedAt }));

    // Unhandled types are acknowledged and logged only: no ledger row, no
    // delivery row. The shared account's other traffic must not fill tables.
    if (parsed.facts.kind === 'other') {
      finish({ disposition: 'unhandled', reason: 'acknowledged' });
      return;
    }
    const identityBase = parsed.identity;
    const deliveryBase = {
      requestId,
      receivedAt,
      eventId: identityBase.eventId,
      eventType: identityBase.eventType,
      livemode: identityBase.livemode,
    };

    let outcome: WebhookOutcome;
    let deliveryOutcome: 'processed' | 'duplicate';
    let result: PhaseOneResult;
    try {
      const applied = await this.applyVerifiedEvent(stripe, em, event, parsed, requestId, { trigger: 'webhook' });
      outcome = applied.outcome;
      deliveryOutcome = applied.duplicate ? 'duplicate' : 'processed';
      result = applied.result;
      if (result.kind === 'done' && result.decision.disposition === 'requires_action') {
        this.logger.warn(
          stripeWebhookRequiresAction({
            requestId,
            eventId: identityBase.eventId,
            eventType: identityBase.eventType,
            objectId,
            organizationId: result.organizationId,
            reason: result.decision.reason,
          }),
        );
      }
    } catch (error) {
      this.logger.warn(stripeWebhookFailed({ requestId, event, objectId, error }));
      const { errorName, sqlState } = errorClassification(error);
      try {
        await insertDelivery(em, {
          ...deliveryBase,
          durationMs: Date.now() - startedAt,
          outcome: 'failed',
          errorName,
          sqlState,
        });
      } catch (recordError) {
        this.logger.warn(
          stripeWebhookDeliveryRecordFailed({
            requestId,
            event,
            outcome: { disposition: 'ignored', reason: 'failed' },
            error: recordError,
          }),
        );
      }
      throw opaqueFailure(error);
    }

    // Phase 2: the committed effect (or the settled duplicate) stands whatever
    // happens here. A duplicate can never become a `failed` row.
    try {
      await insertDelivery(em, {
        ...deliveryBase,
        durationMs: Date.now() - startedAt,
        outcome: deliveryOutcome,
        errorName: null,
        sqlState: null,
      });
    } catch (error) {
      this.logger.warn(stripeWebhookDeliveryRecordFailed({ requestId, event, outcome, error }));
      throw opaqueFailure(error);
    }
    finish(outcome);
  }

  // ───────────────────────── reapply ─────────────────────────

  /**
   * Owner resolution of a `requires_action` event, under the same two-phase
   * rule as the webhook: everything Stripe is asked happens BEFORE the
   * transaction; inside it the event row is locked and re-checked, the
   * organization is locked and re-read, ownership is re-validated and the
   * transition recomputed. The disposition moves exactly once.
   */
  async reapplyEvent(
    eventId: string,
    actor: { id: string; email: string | null },
    requestId: string,
  ): Promise<ReapplyOutcome> {
    const stripe = this.require();
    const em = this.storeRepository.getEntityManager();

    const existing = await findExistingEvent(em, eventId);
    if (!existing) return { kind: 'not_found' };
    if (existing.disposition !== 'requires_action' || existing.resolvedAt) return { kind: 'already_resolved' };

    // Phase 0: rebuild the facts from Stripe's CURRENT objects; nothing stored.
    // The event's RECORDED identity (object, subscription, organization) is
    // authoritative: Stripe's current metadata may inform the transition, it
    // may not redirect the event to another company.
    const parsed = await this.rebuildFromStripe(stripe, existing);
    const identityProblem = reapplyIdentityProblem(existing, parsed);
    const pinnedOrganizationId = existing.organizationId;
    let outcome: ReapplyPhaseOneResult | null = null;
    for (let attempt = 0; attempt <= MAX_PHASE_ZERO_RESTARTS && !outcome; attempt++) {
      const read0 = await this.readLocal(em, parsed.facts, pinnedOrganizationId);
      const retrieved =
        !identityProblem && retrievalRequired(parsed.facts, read0.local, KNOWN_PLANS)
          ? await this.retrieveSubscription(stripe, parsed.facts.subscriptionId as string)
          : null;
      const retrievedAt = retrieved ? new Date() : null;
      try {
        outcome = await em.transactional<ReapplyPhaseOneResult>(async (tem) => {
          const locked = await lockEventForReapply(tem, eventId);
          if (!locked || locked.disposition !== 'requires_action' || locked.resolvedAt)
            return { kind: 'already_resolved' };
          const phaseStart = new Date();
          if (identityProblem) {
            // Recorded, never silent: the attempt is history even though it
            // changed nothing, and the disposition stays open.
            await insertProcessing(tem, {
              eventId,
              trigger: 'reapply',
              basis: 'stripe_retrieve',
              actorUserId: actor.id,
              requestId,
              startedAt: phaseStart,
              result: 'no_change',
              reasonCode: identityProblem,
              retrievedSubscriptionStatus: null,
              retrievedAt: null,
              effect: 'none',
              paymentId: null,
              auditLogId: null,
              localStateBefore: { organization: locked.organizationId },
              localStateAfter: { organization: locked.organizationId },
            });
            return { kind: 'no_change', reason: identityProblem };
          }
          await lockObject(tem, locked.objectType, locked.objectId);
          const read1 = await this.readLocal(
            tem,
            parsed.facts,
            pinnedOrganizationId ?? read0.organization?.id ?? null,
            true,
            parsed.invoice?.id ?? null,
          );
          if (read1.relationKey !== read0.relationKey) throw new RestartFromPhaseZero();
          if (pinnedOrganizationId && !read1.organization) {
            // The recorded company is archived or gone. Not "foreign": the
            // item stays open, the attempt is history.
            await insertProcessing(tem, {
              eventId,
              trigger: 'reapply',
              basis: 'stripe_retrieve',
              actorUserId: actor.id,
              requestId,
              startedAt: phaseStart,
              result: 'no_change',
              reasonCode: 'organization_unavailable',
              retrievedSubscriptionStatus: null,
              retrievedAt: null,
              effect: 'none',
              paymentId: null,
              auditLogId: null,
              localStateBefore: { organization: pinnedOrganizationId },
              localStateAfter: { organization: pinnedOrganizationId },
            });
            return { kind: 'no_change', reason: 'organization_unavailable' };
          }
          const planCheck = await this.planChecks(tem, read1.organization, candidatePlans(parsed.facts, retrieved));
          const decision = decide(parsed.facts, read1.local, retrieved, planCheck, KNOWN_PLANS);
          const stillOpen = decision.disposition === 'requires_action' || decision.disposition === 'unhandled';
          const settled: 'applied' | 'ignored' = decision.disposition === 'applied' ? 'applied' : 'ignored';
          const applied = stillOpen
            ? {
                paymentId: null,
                auditLogId: null,
                before: snapshot(read1.organization),
                after: snapshot(read1.organization),
              }
            : await this.applyDecision(tem, read1.organization, decision, parsed, { id: actor.id, email: actor.email });
          await insertProcessing(tem, {
            eventId,
            trigger: 'reapply',
            basis: 'stripe_retrieve',
            actorUserId: actor.id,
            requestId,
            startedAt: phaseStart,
            result: stillOpen ? 'no_change' : settled,
            reasonCode: decision.reason,
            retrievedSubscriptionStatus:
              retrieved && retrieved.found ? retrieved.status : retrieved ? 'not_found' : null,
            retrievedAt,
            effect: stillOpen ? 'none' : decision.effect,
            paymentId: applied.paymentId,
            auditLogId: applied.auditLogId,
            localStateBefore: applied.before,
            localStateAfter: applied.after,
          });
          if (stillOpen) return { kind: 'no_change', reason: decision.reason };
          await resolveEvent(tem, {
            eventId,
            disposition: settled,
            reasonCode: decision.reason,
            resolvedByUserId: actor.id,
            resolutionCode: decision.reason,
          });
          return { kind: 'resolved', result: settled, reason: decision.reason };
        });
      } catch (error) {
        if (error instanceof RestartFromPhaseZero && attempt < MAX_PHASE_ZERO_RESTARTS) continue;
        this.logger.warn(stripeEventReapplyFailed({ requestId, eventId, actorUserId: actor.id, error }));
        throw opaqueFailure(error);
      }
    }
    if (!outcome) throw new Error('reapply phase one did not settle');
    this.logger.log(
      stripeEventReapplied({
        requestId,
        eventId,
        eventType: existing.eventType,
        actorUserId: actor.id,
        result: outcome.kind === 'resolved' ? outcome.result : outcome.kind,
        reason: outcome.kind === 'already_resolved' ? 'already_resolved' : outcome.reason,
      }),
    );
    return outcome;
  }

  // ───────────────────────── shared machinery ─────────────────────────

  /** Stripe's current view of a subscription; a 404 is a fact, anything else is a retry. */
  /**
   * The verified event, through the ledger (#248 PR B; shared with PR C's
   * settlement). Phase 0: the duplicate fast path, the plain read, the Stripe
   * retrieval the table requires. Phase 1: one transaction — claim, locks,
   * re-read, decide, apply, settle the company's checkout attempt for the
   * session, record the processing, finalise. A lost claim is a duplicate.
   */
  private async applyVerifiedEvent(
    stripe: Stripe,
    em: EntityManager,
    event: Stripe.Event,
    parsed: ParsedEvent,
    requestId: string,
    run: { trigger: 'webhook' } | { trigger: 'settlement'; actor: CheckoutActor },
  ): Promise<{ outcome: WebhookOutcome; duplicate: boolean; result: PhaseOneResult }> {
    const identityBase = parsed.identity;
    const actor: Actor = run.trigger === 'webhook' ? { id: null, email: 'stripe' } : run.actor;
    if (run.trigger === 'settlement' && !actor.id) throw new Error('settlement requires an identified actor');
    void event;

    // Fast path: settled events never reach Stripe again.
    const settled = await findExistingEvent(em, identityBase.eventId);
    if (settled) {
      const bumped = await recordRedelivery(em, identityBase.eventId);
      return {
        outcome: {
          disposition: 'duplicate',
          reason: bumped?.reasonCode ?? settled.reasonCode,
          organizationId: settled.organizationId,
        },
        duplicate: true,
        result: { kind: 'lost_race' },
      };
    }

    let result: PhaseOneResult | null = null;
    for (let attempt = 0; attempt <= MAX_PHASE_ZERO_RESTARTS && !result; attempt++) {
      const read0 = await this.readLocal(em, parsed.facts, null);
      const retrieved = retrievalRequired(parsed.facts, read0.local, KNOWN_PLANS)
        ? await this.retrieveSubscription(stripe, parsed.facts.subscriptionId as string)
        : null;
      const retrievedAt = retrieved ? new Date() : null;
      try {
        result = await em.transactional<PhaseOneResult>(async (tem) => {
          const claimToken = await claimEvent(
            tem,
            { ...identityBase, organizationId: read0.organization?.id ?? null },
            requestId,
          );
          if (!claimToken) return { kind: 'lost_race' };
          const phaseStart = new Date();
          await lockObject(tem, identityBase.objectType, identityBase.objectId);
          const read1 = await this.readLocal(
            tem,
            parsed.facts,
            read0.organization?.id ?? null,
            true,
            parsed.invoice?.id ?? null,
          );
          if (read1.relationKey !== read0.relationKey) throw new RestartFromPhaseZero();
          const planCheck = await this.planChecks(tem, read1.organization, candidatePlans(parsed.facts, retrieved));
          const decision = decide(parsed.facts, read1.local, retrieved, planCheck, KNOWN_PLANS);
          const applied = await this.applyDecision(tem, read1.organization, decision, parsed, actor);
          await this.settleAttemptFromEvent(tem, parsed, identityBase.eventId, decision);
          await insertProcessing(tem, {
            eventId: identityBase.eventId,
            trigger: run.trigger,
            basis: run.trigger === 'webhook' ? 'event_payload' : 'stripe_retrieve',
            actorUserId: actor.id,
            requestId,
            startedAt: phaseStart,
            result: decision.disposition === 'unhandled' ? 'ignored' : decision.disposition,
            reasonCode: decision.reason,
            retrievedSubscriptionStatus:
              retrieved && retrieved.found ? retrieved.status : retrieved ? 'not_found' : null,
            retrievedAt,
            effect: decision.effect,
            paymentId: applied.paymentId,
            auditLogId: applied.auditLogId,
            localStateBefore: applied.before,
            localStateAfter: applied.after,
          });
          await finalizeEvent(tem, {
            eventId: identityBase.eventId,
            claimToken,
            disposition: decision.disposition === 'unhandled' ? 'ignored' : decision.disposition,
            reasonCode: decision.reason,
            organizationId: read1.organization?.id ?? null,
          });
          return { kind: 'done', decision, organizationId: read1.organization?.id ?? null };
        });
      } catch (error) {
        if (error instanceof RestartFromPhaseZero && attempt < MAX_PHASE_ZERO_RESTARTS) continue;
        throw error;
      }
    }
    if (!result) throw new Error('webhook phase one did not settle');

    if (result.kind === 'lost_race') {
      // The transactional claim lost to a concurrent first delivery.
      const bumped = await recordRedelivery(em, identityBase.eventId);
      return {
        outcome: {
          disposition: 'duplicate',
          reason: bumped?.reasonCode ?? 'settled',
          organizationId: bumped?.organizationId ?? null,
        },
        duplicate: true,
        result,
      };
    }
    return {
      outcome: {
        disposition: result.decision.disposition,
        reason: result.decision.reason,
        organizationId: result.organizationId,
      },
      duplicate: false,
      result,
    };
  }

  /**
   * The company's checkout attempt for the event's session (#248 PR C), moved
   * inside the event's transaction: `completed` with the event id when the
   * session completed (whatever the decision — the hosted page is finished),
   * `expired` for `checkout.session.expired`. A session without an attempt (a
   * foreign session, or one issued before attempts existed) changes nothing.
   */
  private async settleAttemptFromEvent(
    tem: EntityManager,
    parsed: ParsedEvent,
    eventId: string,
    decision: Decision,
  ): Promise<void> {
    const facts = parsed.facts;
    if ((facts.kind !== 'checkout' && facts.kind !== 'checkout_expired') || !facts.objectId) return;
    const attempt = await findAttemptBySession(tem, facts.objectId);
    if (!attempt || (attempt.status !== 'creating' && attempt.status !== 'open')) return;
    if (facts.kind === 'checkout_expired') {
      await settleAttempt(tem, attempt.organizationId, attempt.id, {
        status: 'expired',
        settleNote: 'session_expired',
      });
      return;
    }
    if (facts.session?.status === 'complete') {
      await settleAttempt(tem, attempt.organizationId, attempt.id, {
        status: 'completed',
        completedEventId: eventId,
        settleNote: decision.reason.slice(0, 64),
      });
    }
  }

  private async retrieveSubscription(stripe: Stripe, subscriptionId: string): Promise<RetrievedSubscription> {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return {
        found: true,
        id: sub.id,
        status: sub.status,
        customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
        organizationIdFromMetadata: sub.metadata?.organizationId ?? null,
        lookupKey: sub.items?.data?.[0]?.price?.lookup_key ?? null,
      };
    } catch (error) {
      const err = error as { code?: string; statusCode?: number };
      if (err?.code === 'resource_missing' || err?.statusCode === 404) return { found: false };
      throw error;
    }
  }

  /** Reapply has no payload: the facts come from the object as Stripe holds it now. */
  private async rebuildFromStripe(stripe: Stripe, existing: ExistingEvent): Promise<ParsedEvent> {
    const base = {
      id: existing.eventId,
      type: existing.eventType,
      livemode: true,
      created: Math.floor(Date.now() / 1000),
    };
    if (existing.objectType === 'checkout.session') {
      const session = await stripe.checkout.sessions.retrieve(existing.objectId);
      return parseEvent({ ...base, data: { object: session } } as unknown as Stripe.Event);
    }
    if (existing.objectType === 'invoice') {
      const invoice = await stripe.invoices.retrieve(existing.objectId);
      return parseEvent({ ...base, data: { object: invoice } } as unknown as Stripe.Event);
    }
    const subscription = await stripe.subscriptions.retrieve(existing.objectId);
    return parseEvent({ ...base, data: { object: subscription } } as unknown as Stripe.Event);
  }

  /**
   * The organization the event resolves to and the facts the transition needs.
   * `locked` re-reads under the organization advisory lock and a row lock, and
   * evaluates the explicit guards behind the unique indexes.
   */
  private async readLocal(
    em: EntityManager,
    facts: EventFacts,
    pinnedOrganizationId: string | null,
    locked = false,
    invoiceId: string | null = null,
  ): Promise<LocalRead> {
    let organization: Organization | null = null;
    let namedButUnknown = false;
    const findOrg = async (where: Record<string, unknown>) => {
      if (locked) {
        const found = await em.findOne(Organization, { ...where, archivedAt: null });
        if (!found) return null;
        await OrganizationPlanPolicy.lock(em, found.id);
        return em.findOne(Organization, { id: found.id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
      }
      // Phase 0 must see the database, not the identity map: a restart after a
      // concurrent commit re-reads through this path.
      return em.findOne(Organization, { ...where, archivedAt: null }, { refresh: true });
    };
    if (pinnedOrganizationId) {
      organization = await findOrg({ id: pinnedOrganizationId });
    } else if (facts.kind === 'checkout' || facts.kind === 'checkout_expired') {
      if (facts.organizationIdFromMetadata) {
        organization = await findOrg({ id: facts.organizationIdFromMetadata });
        namedButUnknown = !organization;
      }
    } else if (facts.kind === 'invoice') {
      if (facts.customerId) organization = await findOrg({ stripeCustomerId: facts.customerId });
      if (!organization && facts.organizationIdFromMetadata) {
        organization = await findOrg({ id: facts.organizationIdFromMetadata });
        namedButUnknown = !organization;
      }
    } else if (facts.kind === 'deletion' && facts.subscriptionId) {
      organization = await findOrg({ stripeSubscriptionId: facts.subscriptionId });
      if (!organization) organization = await findOrg({ stripePreviousSubscriptionId: facts.subscriptionId });
      if (!organization && facts.organizationIdFromMetadata) {
        organization = await findOrg({ id: facts.organizationIdFromMetadata });
        namedButUnknown = !organization;
      }
    }
    // A malformed organization name in the metadata is "named but unknown":
    // the paid customer's item must reach the owner, not fail forever.
    if (!organization && facts.organizationIdMalformed) namedButUnknown = true;
    const storeCount = organization ? await em.count(Store, { organization: organization.id, archivedAt: null }) : 0;
    const localOrganization: LocalOrganization | null = organization
      ? {
          id: organization.id,
          plan: organization.plan,
          billingStatus: organization.billingStatus,
          customerId: organization.stripeCustomerId ?? null,
          current: organization.stripeSubscriptionId ?? null,
          previous: organization.stripePreviousSubscriptionId ?? null,
          storeCount,
        }
      : null;
    const invoiceRecorded = locked && invoiceId ? await invoiceAlreadyRecorded(em, invoiceId) : false;
    const objectApplied =
      locked && facts.objectId ? await objectAlreadyApplied(em, facts.eventType, facts.objectId) : false;
    const local: LocalFacts = {
      organization: localOrganization,
      organizationNamedButUnknown: namedButUnknown,
      invoiceAlreadyRecorded: invoiceRecorded,
      objectAlreadyApplied: objectApplied,
    };
    // Phase 0 cannot evaluate the guards (they need the lock); the key compares
    // only what phase 0 could see, so a guard hit under lock is a decision, not
    // a restart.
    const relationKey = [
      localOrganization?.id ?? '',
      localOrganization?.current ?? '',
      localOrganization?.previous ?? '',
    ].join('|');
    return { organization, local, relationKey };
  }

  /**
   * The same plan-capacity validation checkout uses, evaluated under the lock
   * for the plans an event could target (the session's plan, the retrieved
   * price's plan). The decision function is synchronous and pure; it receives
   * the answers, not the database.
   */
  private async planChecks(
    tem: EntityManager,
    organization: Organization | null,
    candidates: string[],
  ): Promise<PlanCheck> {
    const results = new Map<string, 'ok' | 'refused'>();
    for (const plan of candidates) {
      if (!organization || !PLANS[plan]) {
        results.set(plan, 'refused');
        continue;
      }
      try {
        await OrganizationPlanPolicy.assertPlanChange(tem, organization, PLANS[plan]);
        results.set(plan, 'ok');
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        results.set(plan, 'refused');
      }
    }
    return (plan: string) => results.get(plan) ?? 'refused';
  }

  /**
   * Applies the effect the decision names. Nothing is written for `ignored`,
   * `requires_action` or `unhandled`. The audit entry is strict: its failure
   * rolls the whole event back.
   */
  private async applyDecision(
    tem: EntityManager,
    organization: Organization | null,
    decision: Decision,
    parsed: ParsedEvent,
    actor: Actor,
  ): Promise<{
    paymentId: string | null;
    auditLogId: string | null;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }> {
    const before = snapshot(organization);
    if (decision.effect === 'none' || !organization) {
      return { paymentId: null, auditLogId: null, before, after: before };
    }
    let paymentId: string | null = null;
    let auditLogId: string | null = null;
    const context = { organizationId: organization.id };

    if (decision.effect === 'activated' || decision.effect === 'adopted') {
      const planBefore = organization.plan;
      const statusBefore = organization.billingStatus;
      organization.plan = decision.targetPlan as string;
      organization.billingStatus = 'ACTIVE';
      organization.stripeSubscriptionId = decision.targetSubscription as string;
      await tem.flush();
      if (decision.effect === 'adopted' && parsed.invoice)
        paymentId = await this.recordPayment(tem, organization, parsed);
      const entry = await this.auditLogService.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.ORGANIZATION,
        organization.id,
        Action.UPDATE,
        {
          plan: { before: planBefore, after: organization.plan },
          billingStatus: { before: statusBefore, after: 'ACTIVE' },
        },
        decision.effect === 'activated'
          ? `Stripe checkout completed: plan ${organization.plan} active for "${organization.name}"`
          : `Stripe invoice paid before checkout completed: plan ${organization.plan} adopted and active for "${organization.name}"`,
        context,
      );
      auditLogId = entry.id;
    } else if (decision.effect === 'restored') {
      const statusBefore = organization.billingStatus;
      organization.billingStatus = 'ACTIVE';
      await tem.flush();
      if (parsed.invoice) paymentId = await this.recordPayment(tem, organization, parsed);
      const entry = await this.auditLogService.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.ORGANIZATION,
        organization.id,
        Action.UPDATE,
        { billingStatus: { before: statusBefore, after: 'ACTIVE' } },
        `Stripe invoice paid: "${organization.name}" is active`,
        context,
      );
      auditLogId = entry.id;
    } else if (decision.effect === 'payment_recorded') {
      if (parsed.invoice) paymentId = await this.recordPayment(tem, organization, parsed);
    } else if (decision.effect === 'suspended') {
      const statusBefore = organization.billingStatus;
      organization.stripePreviousSubscriptionId = decision.targetSubscription as string;
      organization.stripeSubscriptionId = undefined;
      organization.billingStatus = 'SUSPENDED';
      await tem.flush();
      const entry = await this.auditLogService.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.ORGANIZATION,
        organization.id,
        Action.UPDATE,
        { billingStatus: { before: statusBefore, after: 'SUSPENDED' } },
        `Stripe subscription cancelled for "${organization.name}" — panel is read-only until they pay again`,
        context,
      );
      auditLogId = entry.id;
    }
    return { paymentId, auditLogId, before, after: snapshot(organization) };
  }

  /** The payment row for an invoice, on the organization's first live store. */
  private async recordPayment(tem: EntityManager, organization: Organization, parsed: ParsedEvent): Promise<string> {
    const invoice = parsed.invoice as InvoiceFacts;
    const store = await tem.findOne(Store, { organization: organization.id, archivedAt: null });
    if (!store)
      throw new Error('payment row needs a store; the transition table routes this to requires_action/no_store');
    const payment = tem.create(Payment, {
      store,
      amountUsd: (invoice.amountPaid / 100).toFixed(2),
      description: `Stripe — ${PLANS[organization.plan]?.name ?? organization.plan} (${invoice.number || invoice.id})`,
      status: 'PAID',
      invoiceUrl: invoice.hostedInvoiceUrl || undefined,
      stripeEventId: parsed.identity.eventId,
      stripeInvoiceId: invoice.id,
      paidAt: new Date((invoice.created ?? Math.floor(Date.now() / 1000)) * 1000),
      createdAt: new Date(),
    } as any);
    tem.persist(payment);
    await tem.flush();
    return payment.id;
  }
}

/**
 * Whether Stripe's current object still IS the event the ledger recorded. The
 * object id, the subscription it names and the organization it was recorded
 * against must all agree; anything else is `identity_changed`, which a
 * reapply records and refuses to act on.
 */
function reapplyIdentityProblem(existing: ExistingEvent, parsed: ParsedEvent): 'identity_changed' | null {
  if (parsed.identity.objectId !== existing.objectId) return 'identity_changed';
  if (existing.subscriptionId && parsed.facts.subscriptionId !== existing.subscriptionId) return 'identity_changed';
  if (
    existing.organizationId &&
    parsed.facts.organizationIdFromMetadata &&
    parsed.facts.organizationIdFromMetadata !== existing.organizationId
  ) {
    return 'identity_changed';
  }
  return null;
}

/** The plans a decision could name, so their capacity checks run under the lock. */
function candidatePlans(facts: EventFacts, retrieved: RetrievedSubscription | null): string[] {
  const plans = new Set<string>();
  if (facts.session?.plan) plans.add(facts.session.plan);
  if (retrieved && retrieved.found && retrieved.lookupKey && PLAN_BY_LOOKUP_KEY[retrieved.lookupKey]) {
    plans.add(PLAN_BY_LOOKUP_KEY[retrieved.lookupKey]);
  }
  return [...plans].filter((plan) => KNOWN_PLANS.has(plan));
}

function snapshot(organization: Organization | null): Record<string, unknown> {
  if (!organization) return { organization: null };
  return {
    plan: organization.plan,
    billingStatus: organization.billingStatus,
    current: organization.stripeSubscriptionId ?? null,
    previous: organization.stripePreviousSubscriptionId ?? null,
  };
}

const idOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  const id = (value as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : null;
};

/** The event's own facts, and nothing derived from local state. */
export function parseEvent(event: Stripe.Event): ParsedEvent {
  const created = new Date((typeof event.created === 'number' ? event.created : Math.floor(Date.now() / 1000)) * 1000);
  const identityBase = {
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: created,
    livemode: typeof event.livemode === 'boolean' ? event.livemode : false,
    apiVersion: typeof event.api_version === 'string' ? event.api_version : null,
    stripeIdempotencyKey: (event.request as { idempotency_key?: string | null } | null)?.idempotency_key ?? null,
  };
  const other = (): ParsedEvent => ({
    facts: {
      kind: 'other',
      eventType: event.type,
      objectId: stripeObjectId(event),
      organizationIdFromMetadata: null,
      customerId: null,
      subscriptionId: null,
      session: null,
    },
    identity: {
      ...identityBase,
      objectType: 'subscription',
      objectId: stripeObjectId(event) ?? '',
      subscriptionId: null,
    },
    invoice: null,
  });

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (typeof session?.id !== 'string') return other();
    const sessionFacts: SessionFacts = {
      mode: session.mode ?? null,
      status: session.status ?? null,
      paymentStatus: session.payment_status ?? null,
      plan: session.metadata?.plan ?? null,
    };
    return {
      facts: {
        kind: event.type === 'checkout.session.expired' ? 'checkout_expired' : 'checkout',
        eventType: event.type,
        objectId: session.id,
        organizationIdFromMetadata: organizationIdFromMetadata(session.metadata?.organizationId).id,
        organizationIdMalformed: organizationIdFromMetadata(session.metadata?.organizationId).malformed,
        customerId: idOf(session.customer),
        subscriptionId: idOf(session.subscription),
        session: sessionFacts,
      },
      identity: {
        ...identityBase,
        objectType: 'checkout.session',
        objectId: session.id,
        subscriptionId: idOf(session.subscription),
      },
      invoice: null,
    };
  }
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    if (typeof invoice?.id !== 'string') return other();
    const details = invoice.parent?.subscription_details ?? null;
    const subscriptionId = idOf(details?.subscription);
    return {
      facts: {
        kind: 'invoice',
        eventType: event.type,
        objectId: invoice.id,
        organizationIdFromMetadata: organizationIdFromMetadata(details?.metadata?.organizationId).id,
        organizationIdMalformed: organizationIdFromMetadata(details?.metadata?.organizationId).malformed,
        customerId: idOf(invoice.customer),
        subscriptionId,
        session: null,
      },
      identity: { ...identityBase, objectType: 'invoice', objectId: invoice.id, subscriptionId },
      invoice: {
        id: invoice.id,
        number: invoice.number ?? null,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        amountPaid: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0,
        created: typeof invoice.created === 'number' ? invoice.created : null,
      },
    };
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    if (typeof sub?.id !== 'string') return other();
    return {
      facts: {
        kind: 'deletion',
        eventType: event.type,
        objectId: sub.id,
        organizationIdFromMetadata: organizationIdFromMetadata(sub.metadata?.organizationId).id,
        organizationIdMalformed: organizationIdFromMetadata(sub.metadata?.organizationId).malformed,
        customerId: idOf(sub.customer),
        subscriptionId: sub.id,
        session: null,
      },
      identity: { ...identityBase, objectType: 'subscription', objectId: sub.id, subscriptionId: sub.id },
      invoice: null,
    };
  }
  return other();
}
