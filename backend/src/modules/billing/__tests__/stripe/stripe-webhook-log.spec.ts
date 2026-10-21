import { BadRequestException, Logger } from '@nestjs/common';
import { StripeService } from '../../stripe/stripe.service';

/**
 * The records a delivery leaves before it ever touches the ledger, and the
 * duplicate fast path (#248, PR A + PR B).
 *
 * Everything that reaches the transition table is proven on real PostgreSQL in
 * `stripe-webhook-wire.pg.spec.ts`; this file pins, with a mocked database,
 * the paths that must not need one: refusals at the door, an unhandled type,
 * a database failure, and the rule that a settled event is answered without
 * contacting Stripe or re-evaluating anything. The sentinels stand in for the
 * things a webhook body carries that must never reach a log.
 */
const SENTINELS = [
  'SECRET-INVOICE-URL',
  'SECRET-EMAIL',
  'SECRET-METADATA',
  'SECRET-SIGNATURE',
  'SECRET-DRIVER-MESSAGE',
];

describe('Stripe webhook deliveries are logged attributably, by outcome, and safely', () => {
  let logs: string[];
  let warns: string[];
  let service: StripeService;
  let execute: jest.Mock;
  let constructEvent: jest.Mock;
  let retrieve: jest.Mock;

  beforeEach(() => {
    logs = [];
    warns = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warns.push(String(message));
    });
    // Nest's default exception handler logs at ERROR level; the sentinel scan
    // must see that channel too.
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown, ...rest: unknown[]) => {
      warns.push([message, ...rest].map(String).join(' '));
    });
    execute = jest.fn().mockResolvedValue([]);
    const em: any = { execute, findOne: jest.fn(), count: jest.fn(), transactional: jest.fn() };
    constructEvent = jest.fn();
    retrieve = jest.fn().mockRejectedValue(Object.assign(new Error('Stripe unavailable'), { statusCode: 503 }));
    const storeRepository: any = { getEntityManager: () => em };
    service = new StripeService(
      { get: jest.fn().mockReturnValue('configured') } as any,
      storeRepository,
      { recordAuditEntry: jest.fn(), recordAuditEntryIn: jest.fn() } as any,
    );
    (service as any).stripe = { webhooks: { constructEvent }, subscriptions: { retrieve } };
  });

  afterEach(() => jest.restoreAllMocks());

  const deliver = (event: unknown, requestId = 'req-under-test-001') => {
    constructEvent.mockReturnValue(event);
    return service.handleWebhook(Buffer.from('{}'), 'SECRET-SIGNATURE', { requestId });
  };

  const only = () => {
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0]) as Record<string, unknown>;
  };

  const assertNothingLeaked = () => {
    for (const line of [...logs, ...warns]) {
      for (const sentinel of SENTINELS) expect(line).not.toContain(sentinel);
    }
  };

  const invoiceEvent = () => ({
    id: 'evt_invoice_1',
    type: 'invoice.paid',
    livemode: true,
    created: 1756700000,
    data: {
      object: {
        id: 'in_1',
        customer: 'cus_1',
        customer_email: 'SECRET-EMAIL@example.test',
        amount_paid: 3000,
        hosted_invoice_url: 'https://SECRET-INVOICE-URL.example.test/i',
        created: 1756700000,
        metadata: { note: 'SECRET-METADATA' },
        parent: { subscription_details: { subscription: 'sub_1', metadata: { note: 'SECRET-METADATA' } } },
      },
    },
  });

  describe('refusals at the door', () => {
    it('an invalid signature is a warn record with the request id and no event id, still a 400, and nothing is stored', async () => {
      constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching SECRET-SIGNATURE');
      });
      await expect(
        service.handleWebhook(Buffer.from('{}'), 'SECRET-SIGNATURE', { requestId: 'req-under-test-002' }),
      ).rejects.toThrow(BadRequestException);
      expect(logs).toHaveLength(0);
      expect(JSON.parse(warns[0])).toEqual({
        event: 'stripe_webhook_rejected',
        requestId: 'req-under-test-002',
        reason: 'invalid_signature',
      });
      expect(execute).not.toHaveBeenCalled(); // PRB-D1: rejected requests write no rows
      expect(retrieve).not.toHaveBeenCalled();
      assertNothingLeaked();
    });

    it('a missing webhook secret is recorded as not_configured', async () => {
      (service as any).configService = { get: () => undefined };
      await expect(deliver(invoiceEvent())).rejects.toThrow('Webhook not configured');
      expect(JSON.parse(warns[0])).toMatchObject({ event: 'stripe_webhook_rejected', reason: 'not_configured' });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('unhandled types', () => {
    it('are acknowledged and logged with their event id, and touch neither the ledger nor Stripe', async () => {
      await deliver({
        id: 'evt_pf_1',
        type: 'invoice.payment_failed',
        livemode: true,
        data: { object: { id: 'in_pf' } },
      });
      expect(only()).toMatchObject({
        event: 'stripe_webhook',
        requestId: 'req-under-test-001',
        eventId: 'evt_pf_1',
        eventType: 'invoice.payment_failed',
        objectId: 'in_pf',
        disposition: 'unhandled',
        reason: 'acknowledged',
      });
      expect(execute).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
    });

    it('livemode is null, not a guess, when the event does not carry it', async () => {
      await deliver({ id: 'evt_x', type: 'invoice.payment_failed', data: { object: {} } });
      expect(only()).toMatchObject({ livemode: null, objectId: null });
    });
  });

  describe('the duplicate fast path', () => {
    it('a settled event is answered from the ledger: no Stripe call, no re-evaluation, one duplicate delivery row', async () => {
      const settled = {
        eventId: 'evt_invoice_1',
        eventType: 'invoice.paid',
        disposition: 'applied',
        reasonCode: 'restored',
        organizationId: 'org-1',
        attemptCount: 1,
      };
      execute
        .mockResolvedValueOnce([settled]) // findExistingEvent
        .mockResolvedValueOnce([{ ...settled, attemptCount: 2 }]) // recordRedelivery
        .mockResolvedValueOnce([]); // insertDelivery(duplicate)
      await deliver(invoiceEvent());
      expect(retrieve).not.toHaveBeenCalled();
      expect(only()).toMatchObject({
        eventId: 'evt_invoice_1',
        disposition: 'duplicate',
        reason: 'restored',
        organizationId: 'org-1',
      });
      const sql = execute.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
      expect(sql[0]).toContain('from stripe_events where event_id = ?');
      expect(sql[1]).toContain('attempt_count = attempt_count + 1');
      expect(sql[2]).toContain('insert into stripe_webhook_deliveries');
      expect(execute.mock.calls[2][1]).toContain('duplicate');
      assertNothingLeaked();
    });
  });

  describe('failures', () => {
    it('a database failure is a warn record with class name and SQLSTATE only, a failed delivery row, then rethrown', async () => {
      execute
        .mockRejectedValueOnce(Object.assign(new Error('null value SECRET-DRIVER-MESSAGE'), { code: '23502' })) // fast path lookup fails
        .mockResolvedValueOnce([]); // insertDelivery(failed)
      // The driver message (which quotes values) is recorded as class + SQLSTATE
      // only and replaced by an opaque 500, so Nest's default exception handler
      // has nothing to print.
      await expect(deliver(invoiceEvent())).rejects.toThrow('Stripe webhook processing failed');
      expect(logs).toHaveLength(0);
      expect(JSON.parse(warns[0])).toEqual({
        event: 'stripe_webhook_failed',
        requestId: 'req-under-test-001',
        eventId: 'evt_invoice_1',
        eventType: 'invoice.paid',
        objectId: 'in_1',
        errorName: 'Error',
        sqlState: '23502',
      });
      expect(execute.mock.calls[1][1]).toEqual(expect.arrayContaining(['failed', 'evt_invoice_1', 'Error', '23502']));
      assertNothingLeaked();
    });

    it('when even the failed-delivery row cannot be written, that is its own scrubbed record', async () => {
      execute
        .mockRejectedValueOnce(Object.assign(new Error('boom SECRET-DRIVER-MESSAGE'), { code: '57P01' }))
        .mockRejectedValueOnce(Object.assign(new Error('still down SECRET-DRIVER-MESSAGE'), { code: '57P01' }));
      await expect(deliver(invoiceEvent())).rejects.toThrow('Stripe webhook processing failed');
      expect(warns.map((w) => JSON.parse(w).event)).toEqual([
        'stripe_webhook_failed',
        'stripe_webhook_delivery_record_failed',
      ]);
      expect(JSON.parse(warns[1])).toMatchObject({ eventId: 'evt_invoice_1', errorName: 'Error', sqlState: '57P01' });
      assertNothingLeaked();
    });

    it('a request id is minted when the HTTP layer gave none: the delivery table keys on it', async () => {
      constructEvent.mockReturnValue({ id: 'evt_y', type: 'invoice.payment_failed', data: { object: {} } });
      await service.handleWebhook(Buffer.from('{}'), 'sig');
      expect(String(only().requestId)).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
