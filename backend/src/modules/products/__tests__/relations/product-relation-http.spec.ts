import { CanActivate, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductRelationsController } from '../../relations/product-relations.controller';
import { ProductRelationsService } from '../../relations/product-relations.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

/**
 * The relation routes over a REAL HTTP boundary, through the REAL global
 * validation pipe — including the DELETE body that opts into removing the
 * mirror edge, which only exists if the pipe actually lets it through.
 */
const PIPE_OPTIONS = { whitelist: true, transform: true, forbidNonWhitelisted: true };
const TARGET = '7d9f4d2e-3b6a-4c11-9d2f-5e8b1c7a0f42';

describe('product relation routes over the real ValidationPipe', () => {
  let app: INestApplication;
  const service = { list: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() };

  const allow: CanActivate = {
    canActivate: (context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'u1', email: 'ana@acme.com', role: { name: 'SUPER_ADMIN' }, store: null };
      req.scope = { platform: true, organizationId: 'org-1', storeId: null, allowedStoreIds: [], role: 'SUPER_ADMIN' };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductRelationsController],
      providers: [{ provide: ProductRelationsService, useValue: service }],
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
    for (const fn of Object.values(service)) fn.mockReset();
    service.create.mockResolvedValue({ id: 'rel-1', reciprocalRelationId: null });
    service.update.mockResolvedValue({ id: 'rel-1' });
    service.remove.mockResolvedValue({ removed: true });
    service.list.mockResolvedValue([]);
  });

  const url = '/api/v1/products/prod-1/relations';

  it('accepts a well-formed edge and passes it through unchanged', async () => {
    const response = await request(app.getHttpServer())
      .post(url)
      .send({ targetProductId: TARGET, type: 'ACCESSORY', sortOrder: 2 });

    expect(response.status).toBe(201);
    expect(service.create.mock.calls[0][2]).toMatchObject({
      targetProductId: TARGET,
      type: 'ACCESSORY',
      sortOrder: 2,
    });
  });

  it('carries the reciprocal opt-in as a real boolean', async () => {
    await request(app.getHttpServer())
      .post(url)
      .send({ targetProductId: TARGET, type: 'SIMILAR', reciprocal: true })
      .expect(201);
    expect(service.create.mock.calls[0][2].reciprocal).toBe(true);
  });

  it('rejects an unknown relation type', async () => {
    const response = await request(app.getHttpServer()).post(url).send({ targetProductId: TARGET, type: 'FRIEND_OF' });
    expect(response.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown property rather than dropping it', async () => {
    const response = await request(app.getHttpServer())
      .post(url)
      .send({ targetProductId: TARGET, type: 'RELATED', organizationId: 'org-someone-else' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('organizationId');
  });

  it('rejects a non-uuid target', async () => {
    const response = await request(app.getHttpServer()).post(url).send({ targetProductId: 'nope', type: 'RELATED' });
    expect(response.status).toBe(400);
  });

  it('lets the DELETE body opt into removing the mirror edge', async () => {
    await request(app.getHttpServer()).delete(`${url}/rel-1`).send({ includeReciprocal: true }).expect(200);
    expect(service.remove.mock.calls[0][3]).toEqual({ includeReciprocal: true });
  });

  it('treats a DELETE with no body as "leave the mirror alone"', async () => {
    await request(app.getHttpServer()).delete(`${url}/rel-1`).expect(200);
    expect(service.remove.mock.calls[0][3]).toEqual({});
  });
});
