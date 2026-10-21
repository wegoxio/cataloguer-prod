import { CanActivate, INestApplication, ValidationPipe } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { InventoryController } from '../../inventory.controller';
import { InventoryCommandService } from '../../ledger/inventory-command.service';
import { InventoryReconciliationService } from '../../ledger/inventory-reconciliation.service';
import { InventoryStockService } from '../../ledger/inventory-stock.service';
import { InventoryTransferService } from '../../transfers/inventory-transfer.service';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

/**
 * The Phase 8 inventory routes over a REAL HTTP boundary, through the REAL
 * global pipe — the same lesson category-http.spec.ts carries: under
 * `whitelist` + `forbidNonWhitelisted` a service-level test proves nothing
 * about what an HTTP client can actually send. Every route the operator screen
 * calls is exercised here with its exact body shape, and the shapes the
 * contract REFUSES are pinned as refusals.
 */
const PIPE_OPTIONS = { whitelist: true, transform: true, forbidNonWhitelisted: true };
const PRODUCT = '4a8a6c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const LOCATION = '1f2e3d4c-5b6a-4798-8899-aabbccddeeff';
const TRANSFER = '9e8d7c6b-5a49-4837-8261-504132211009';
const KEY = 'http-contract-key-1';

describe('inventory routes over the real ValidationPipe', () => {
  let app: INestApplication;

  const commands = {
    recount: jest.fn().mockResolvedValue({ posted: true, delta: -2 }),
    reclassifySellability: jest.fn().mockResolvedValue(undefined),
    reassignStock: jest.fn().mockResolvedValue(undefined),
    distributeFamilyStock: jest.fn().mockResolvedValue(undefined),
  };
  const transfers = {
    createDraft: jest.fn().mockResolvedValue(TRANSFER),
    commit: jest.fn(),
    dispatch: jest.fn(),
    receive: jest.fn(),
    startReturn: jest.fn(),
    completeReturn: jest.fn(),
    cancel: jest.fn(),
  };
  const em: { execute: jest.Mock; transactional: jest.Mock } = {
    execute: jest.fn().mockResolvedValue([]),
    transactional: jest.fn(async (work: any): Promise<any> => work(em)),
  };
  const reconciliation = {
    verifyAll: jest.fn().mockResolvedValue([]),
    storeHeldQuantity: jest.fn().mockResolvedValue(0),
    organizationPhysicalTotal: jest.fn().mockResolvedValue(0),
    sellableQuantity: jest.fn().mockResolvedValue(0),
  };
  const stock = {
    defaultWarehouseId: jest.fn().mockResolvedValue(LOCATION),
    locationAvailable: jest.fn().mockResolvedValue(0),
  };
  const audit = { recordAuditEntry: jest.fn().mockResolvedValue(undefined) };

  const allow: CanActivate = {
    canActivate: (context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'u1', email: 'op@example.com', role: { name: 'ORGANIZATION_MANAGER' } };
      req.scope = {
        platform: false,
        role: 'ORGANIZATION_MANAGER',
        organizationId: 'org-1',
        storeId: null,
        allowedStoreIds: [],
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [
        { provide: EntityManager, useValue: em },
        { provide: InventoryStockService, useValue: stock },
        { provide: InventoryCommandService, useValue: commands },
        { provide: InventoryTransferService, useValue: transfers },
        { provide: InventoryReconciliationService, useValue: reconciliation },
        { provide: AuditLogService, useValue: audit },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue(allow)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(PIPE_OPTIONS));
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    em.execute.mockResolvedValue([]);
  });

  describe('the read contracts', () => {
    it('GET products/:id answers the exact stock-view shape the screen renders', async () => {
      const response = await request(app.getHttpServer()).get(`/api/v1/inventory/products/${PRODUCT}`).expect(200);
      // The EXACT key set: a renamed or dropped key here is a broken screen.
      expect(Object.keys(response.body.data).sort()).toEqual(
        [
          'inTransit',
          'nonSellable',
          'organizationTotal',
          'perStore',
          'productId',
          'reserved',
          'sellable',
          'transferCommitted',
          'warehouseRemainder',
        ].sort(),
      );
    });

    it('GET reconciliation answers findings plus the verdict', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/inventory/reconciliation').expect(200);
      expect(response.body.data).toHaveProperty('findings');
      expect(response.body.data).toHaveProperty('healthy');
    });

    it('GET locations and transfers answer list envelopes', async () => {
      const locations = await request(app.getHttpServer()).get('/api/v1/inventory/locations').expect(200);
      expect(locations.body).toHaveProperty('data');
      const list = await request(app.getHttpServer()).get('/api/v1/inventory/transfers?status=DRAFT').expect(200);
      expect(list.body).toHaveProperty('data');
    });
  });

  describe('recount', () => {
    const valid = { productId: PRODUCT, locationId: LOCATION, countedQuantity: 4, reason: 'annual count' };

    it('accepts the exact contract body and passes it through unchanged', async () => {
      await request(app.getHttpServer()).post('/api/v1/inventory/recount').send(valid).expect(201);
      expect(commands.recount).toHaveBeenCalledWith(
        expect.objectContaining({ productId: PRODUCT, locationId: LOCATION, countedQuantity: 4 }),
      );
    });

    it('refuses what the contract does not name', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/inventory/recount')
        .send({ ...valid, surprise: true })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/recount')
        .send({ ...valid, countedQuantity: -1 })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/recount')
        .send({ ...valid, productId: 'not-a-uuid' })
        .expect(400);
      const withoutReason: Record<string, unknown> = { ...valid };
      delete withoutReason.reason;
      await request(app.getHttpServer()).post('/api/v1/inventory/recount').send(withoutReason).expect(400);
      expect(commands.recount).not.toHaveBeenCalled();
    });
  });

  describe('the delta commands demand a key', () => {
    const reclassifyBody = {
      productId: PRODUCT,
      locationId: LOCATION,
      quantity: 1,
      from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
      to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
      reason: 'water damage',
    };

    it('reclassify: refused without Idempotency-Key, accepted with one', async () => {
      const refused = await request(app.getHttpServer())
        .post('/api/v1/inventory/reclassify')
        .send(reclassifyBody)
        .expect(400);
      expect(refused.body.message).toMatch(/Idempotency-Key/);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/reclassify')
        .set('Idempotency-Key', KEY)
        .send(reclassifyBody)
        .expect(201);
      expect(commands.reclassifySellability).toHaveBeenCalledTimes(1);
    });

    it('reclassify: an unknown state in the nested pair is refused', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/inventory/reclassify')
        .set('Idempotency-Key', KEY)
        .send({ ...reclassifyBody, to: { physicalCondition: 'DAMAGED', operationalState: 'TELEPORTED' } })
        .expect(400);
    });

    it('reassign and distribute: same header rule, nested lines validated', async () => {
      const reassignBody = {
        sourceProductId: PRODUCT,
        destinationProductId: LOCATION,
        locationId: LOCATION,
        quantity: 1,
        reason: 'misfiled',
      };
      await request(app.getHttpServer()).post('/api/v1/inventory/reassign').send(reassignBody).expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/reassign')
        .set('Idempotency-Key', KEY)
        .send(reassignBody)
        .expect(201);

      const distributeBody = {
        rootProductId: PRODUCT,
        locationId: LOCATION,
        allocations: [{ productId: PRODUCT, quantity: 1 }],
        reason: 'family split',
      };
      await request(app.getHttpServer())
        .post('/api/v1/inventory/distribute')
        .set('Idempotency-Key', KEY)
        .send({ ...distributeBody, allocations: [] })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/distribute')
        .set('Idempotency-Key', KEY)
        .send({ ...distributeBody, allocations: [{ productId: PRODUCT, quantity: 0 }] })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/distribute')
        .set('Idempotency-Key', KEY)
        .send(distributeBody)
        .expect(201);
    });
  });

  describe('the transfer lifecycle bodies', () => {
    it('create: the exact draft contract, with its refusals', async () => {
      const valid = {
        sourceLocationId: LOCATION,
        destinationLocationId: PRODUCT,
        lines: [{ productId: PRODUCT, quantity: 2 }],
      };
      const created = await request(app.getHttpServer()).post('/api/v1/inventory/transfers').send(valid).expect(201);
      expect(created.body.data).toEqual({ id: TRANSFER, status: 'DRAFT' });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .send({ ...valid, lines: [] })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .send({ ...valid, reference: 'x'.repeat(201) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .send({ ...valid, teleport: true })
        .expect(400);
    });

    it.each(['commit', 'dispatch', 'receive', 'start-return', 'complete-return', 'cancel'])(
      '%s: an empty body is a full step',
      async (step) => {
        await request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${TRANSFER}/${step}`).send({}).expect(201);
      },
    );

    it.each(['dispatch', 'receive', 'start-return'])('%s: named partial quantities pass through', async (step) => {
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${TRANSFER}/${step}`)
        .send({ quantities: { [PRODUCT]: 2 } })
        .expect(201);
      const service = {
        dispatch: transfers.dispatch,
        receive: transfers.receive,
        'start-return': transfers.startReturn,
      }[step]!;
      expect(service).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ transferId: TRANSFER, quantities: { [PRODUCT]: 2 } }),
      );
    });

    it('a property outside the step contract is refused', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${TRANSFER}/start-return`)
        .send({ hurry: true })
        .expect(400);
      expect(transfers.startReturn).not.toHaveBeenCalled();
    });
  });
});
