import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePublicOrderDto, ValidateDiscountDto } from '../public-order.dto';
import { CartItemDto } from '../../../sales/dto/cart-item.dto';
import { PublicCatalogueController } from '../../public-catalogue.controller';

/**
 * #173: the public checkout bodies are validated by the SAME global pipe the
 * app configures. These tests exercise that real pipe, prove nested cart
 * validation and unknown-field rejection, and prove the sales service is never
 * reached when the body is rejected — while a well-formed body against a
 * foreign/missing target still reaches the established downstream check.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

const ITEM = { productId: '11111111-1111-4111-8111-111111111111', quantity: 2 };

describe('public order DTOs (#173)', () => {
  describe('CreatePublicOrderDto', () => {
    it('accepts the full documented payload incl. variantId, idempotencyKey and discountCode', async () => {
      const out = await pipe.transform(
        {
          items: [{ ...ITEM, variantId: '22222222-2222-4222-8222-222222222222' }],
          customerName: 'María',
          customerPhone: '+58412',
          idempotencyKey: 'abc',
          discountCode: 'SUMMER',
        },
        meta(CreatePublicOrderDto),
      );
      expect(out).toBeInstanceOf(CreatePublicOrderDto);
      expect(out.items[0]).toBeInstanceOf(CartItemDto);
    });

    it('rejects a non-numeric quantity (the issue reproduction)', async () => {
      await expect(
        pipe.transform({ items: [{ productId: ITEM.productId, quantity: 'texto' }] }, meta(CreatePublicOrderDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown fields, empty carts, oversized carts and bad quantities', async () => {
      await expect(pipe.transform({ items: [ITEM], evil: 1 }, meta(CreatePublicOrderDto))).rejects.toThrow();
      await expect(pipe.transform({ items: [] }, meta(CreatePublicOrderDto))).rejects.toThrow();
      await expect(pipe.transform({ items: Array(101).fill(ITEM) }, meta(CreatePublicOrderDto))).rejects.toThrow();
      await expect(
        pipe.transform({ items: [{ productId: ITEM.productId, quantity: 0 }] }, meta(CreatePublicOrderDto)),
      ).rejects.toThrow();
      await expect(
        pipe.transform({ items: [{ productId: 'not-a-uuid', quantity: 1 }] }, meta(CreatePublicOrderDto)),
      ).rejects.toThrow();
      await expect(
        pipe.transform({ items: [{ ...ITEM, quantity: 10001 }] }, meta(CreatePublicOrderDto)),
      ).rejects.toThrow();
    });
  });

  describe('ValidateDiscountDto', () => {
    it('accepts a code + cart, rejects an empty code and unknown fields', async () => {
      await expect(pipe.transform({ code: 'X', items: [ITEM] }, meta(ValidateDiscountDto))).resolves.toBeDefined();
      await expect(pipe.transform({ code: '', items: [ITEM] }, meta(ValidateDiscountDto))).rejects.toThrow();
      await expect(pipe.transform({ code: 'X', items: [ITEM], evil: 1 }, meta(ValidateDiscountDto))).rejects.toThrow();
    });
  });

  describe('controller flow: validation runs before the service (ordering)', () => {
    const build = () => {
      const salesService = {
        createFromWebsite: jest.fn().mockResolvedValue({ id: 'o1', orderNumber: 'A1', totalUsd: '9.00' }),
      };
      const controller = new PublicCatalogueController({} as any, salesService as any);
      return { controller, salesService };
    };
    // Mimics Nest: pipe first, handler only on success
    const route = async (fn: (v: any) => any, payload: any, metatype: any) =>
      fn(await pipe.transform(payload, meta(metatype)));

    it('never calls the sales service when the body is rejected', async () => {
      const { controller, salesService } = build();
      const req = { catalogueStoreId: 'store-1' };
      await expect(
        route(
          (v) => controller.createOrder(req, v),
          { items: [{ productId: 'x', quantity: 'texto' }] },
          CreatePublicOrderDto,
        ),
      ).rejects.toThrow();
      expect(salesService.createFromWebsite).not.toHaveBeenCalled();
    });

    it('a valid body with no store key still reaches the established 401 (not a validation 400)', async () => {
      const { controller, salesService } = build();
      const req = { catalogueStoreId: undefined, headers: {} };
      await expect(
        route((v) => controller.createOrder(req, v), { items: [ITEM] }, CreatePublicOrderDto),
      ).rejects.toThrow('Orders require a store API key');
      expect(salesService.createFromWebsite).not.toHaveBeenCalled();
    });

    it('a valid body with a store key passes discountCode through to the service', async () => {
      const { controller, salesService } = build();
      const req = { catalogueStoreId: 'store-1', headers: {} };
      await route(
        (v) => controller.createOrder(req, v),
        { items: [ITEM], discountCode: 'SUMMER' },
        CreatePublicOrderDto,
      );
      expect(salesService.createFromWebsite).toHaveBeenCalledWith(
        'store-1',
        expect.any(Array),
        undefined,
        undefined,
        undefined,
        'SUMMER',
      );
    });
  });
});
