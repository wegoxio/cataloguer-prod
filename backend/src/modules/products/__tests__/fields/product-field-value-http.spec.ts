import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, CanActivate, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductFieldValuesController } from '../../fields/product-fields.controller';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

/**
 * The value endpoint over a REAL HTTP boundary, through the REAL global
 * validation pipe.
 *
 * Why this exists: `UpsertProductFieldValueDto.value` carries no validation
 * decorator on purpose — its shape depends on the definition's type, which
 * class-validator cannot express. But the global pipe runs with
 * `whitelist` + `forbidNonWhitelisted`, and those treat a property with NO
 * decorator metadata as an unknown property and reject the entire request
 * with 400. The endpoint was therefore unreachable from any HTTP client
 * while every service-level test passed, because those call the service
 * directly and never cross the pipe.
 *
 * `@Allow()` is the fix: it whitelists the property without asserting any
 * validation guarantee. These tests pin that behaviour at the boundary where
 * it actually broke.
 */
describe('PUT /products/:productId/fields/:definitionId over the real ValidationPipe', () => {
  let app: INestApplication;
  const upsertValue = jest.fn();

  /**
   * The pipe options MUST mirror main.ts. Asserted against the source below
   * so this suite can never pass against options the application does not
   * actually use.
   */
  const PIPE_OPTIONS = { whitelist: true, transform: true, forbidNonWhitelisted: true };

  const allow: CanActivate = {
    canActivate: (context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'u1', role: { name: 'SUPER_ADMIN' }, store: null };
      req.scope = {
        platform: true,
        organizationId: 'org-1',
        storeId: null,
        allowedStoreIds: ['store-1'],
        role: 'SUPER_ADMIN',
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductFieldValuesController],
      providers: [{ provide: ProductFieldsService, useValue: { upsertValue } }],
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
    upsertValue.mockReset();
    upsertValue.mockResolvedValue({
      definitionId: 'def-1',
      key: 'material',
      label: 'Material',
      type: 'TEXT',
      unit: null,
      value: 'Prepared food',
    });
  });

  const url = '/api/v1/products/prod-1/fields/def-1';

  it('runs against the same pipe options main.ts installs', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '../../../main.ts'), 'utf8');
    const options = main.slice(main.indexOf('new ValidationPipe('), main.indexOf('app.setGlobalPrefix'));
    for (const [key, value] of Object.entries(PIPE_OPTIONS)) {
      expect(options).toContain(`${key}: ${value}`);
    }
  });

  it('accepts a valid TEXT value instead of rejecting it as non-whitelisted', async () => {
    const response = await request(app.getHttpServer()).put(url).send({ value: 'Prepared food' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: expect.objectContaining({ key: 'material', value: 'Prepared food' }),
    });
    expect(upsertValue).toHaveBeenCalledTimes(1);
  });

  it('does not silently discard value: the service receives the exact payload', async () => {
    await request(app.getHttpServer()).put(url).send({ value: 'Prepared food' }).expect(200);

    const [scope, productId, definitionId, dto] = upsertValue.mock.calls[0];
    expect(dto).toBeInstanceOf(UpsertProductFieldValueDtoClass());
    expect(dto.value).toBe('Prepared food');
    expect(Object.prototype.hasOwnProperty.call(dto, 'value')).toBe(true);
    expect(productId).toBe('prod-1');
    expect(definitionId).toBe('def-1');
    expect(scope).toEqual(expect.objectContaining({ organizationId: 'org-1', storeId: null }));
  });

  it('carries a BOOLEAN value across the pipe as a real boolean, not a string', async () => {
    upsertValue.mockResolvedValue({ definitionId: 'def-1', key: 'assembled', type: 'BOOLEAN', value: false });

    await request(app.getHttpServer()).put(url).send({ value: false }).expect(200);

    expect(upsertValue.mock.calls[0][3].value).toBe(false);
  });

  it('still rejects an actually unknown property', async () => {
    const response = await request(app.getHttpServer())
      .put(url)
      .send({ value: 'Prepared food', definitionType: 'TEXT' });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('definitionType');
    expect(upsertValue).not.toHaveBeenCalled();
  });

  it('keeps service-level type and curated-field validation authoritative', async () => {
    upsertValue.mockRejectedValue(
      new BadRequestException({
        code: 'FIELD_VALUE_TOO_LONG',
        definitionKey: 'material',
        reason: 'This field allows at most 500 characters',
        constraint: 'maxLength',
      }),
    );

    // A NUMBER-shaped payload the pipe cannot judge: it must reach the
    // service, and the service's refusal must be what the caller sees.
    const response = await request(app.getHttpServer())
      .put(url)
      .send({ value: 'x'.repeat(501) });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({ code: 'FIELD_VALUE_TOO_LONG', definitionKey: 'material' }));
    expect(upsertValue).toHaveBeenCalledTimes(1);
  });
});

/** The DTO class, imported lazily so the assertion reads as an identity check. */
function UpsertProductFieldValueDtoClass(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../dto/product-field.dto').UpsertProductFieldValueDto;
}
