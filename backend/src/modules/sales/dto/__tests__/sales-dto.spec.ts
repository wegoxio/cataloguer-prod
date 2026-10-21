import { ArgumentMetadata, BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { CreateManualSaleDto } from '../create-manual-sale.dto';
import { SetSaleStatusDto } from '../set-sale-status.dto';
import { SalesController } from '../../sales.controller';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype, data: '' });
const ITEM = { productId: '11111111-1111-4111-8111-111111111111', quantity: 1 };

describe('sales DTOs (#173)', () => {
  it('CreateManualSaleDto accepts the panel payload and bounds fields', async () => {
    await expect(
      pipe.transform({ customerName: 'Ana', customerPhone: '+1', items: [ITEM] }, meta(CreateManualSaleDto)),
    ).resolves.toBeInstanceOf(CreateManualSaleDto);
    // owner variant with storeId
    await expect(
      pipe.transform({ storeId: '33333333-3333-4333-8333-333333333333', items: [ITEM] }, meta(CreateManualSaleDto)),
    ).resolves.toBeDefined();
  });

  it('CreateManualSaleDto rejects empty items, bad storeId, overlong name and unknown fields', async () => {
    await expect(pipe.transform({ items: [] }, meta(CreateManualSaleDto))).rejects.toThrow();
    await expect(pipe.transform({ storeId: 'x', items: [ITEM] }, meta(CreateManualSaleDto))).rejects.toThrow();
    await expect(
      pipe.transform({ customerName: 'a'.repeat(121), items: [ITEM] }, meta(CreateManualSaleDto)),
    ).rejects.toThrow();
    await expect(pipe.transform({ items: [ITEM], evil: 1 }, meta(CreateManualSaleDto))).rejects.toThrow();
  });

  it('SetSaleStatusDto accepts the enum and rejects unknown values', async () => {
    for (const status of ['NEW', 'CONFIRMED', 'PAID', 'DELIVERED', 'CANCELLED']) {
      await expect(pipe.transform({ status }, meta(SetSaleStatusDto))).resolves.toBeDefined();
    }
    await expect(pipe.transform({ status: 'BOGUS' }, meta(SetSaleStatusDto))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform({ status: 'NEW', evil: 1 }, meta(SetSaleStatusDto))).rejects.toThrow();
  });

  it('a rejected status body never reaches the sales service', async () => {
    const salesService = { setStatus: jest.fn() };
    const controller = new SalesController(salesService as any, {} as any);
    const route = async (payload: any) =>
      controller.setStatus({ user: {} }, 'id-1', await pipe.transform(payload, meta(SetSaleStatusDto)));
    await expect(route({ status: 'BOGUS' })).rejects.toThrow();
    expect(salesService.setStatus).not.toHaveBeenCalled();
  });

  it('a valid status against a foreign order still reaches the service 404 (ordering preserved)', async () => {
    const salesService = { setStatus: jest.fn().mockRejectedValue(new NotFoundException('Order not found')) };
    const controller = new SalesController(salesService as any, {} as any);
    const validated = await pipe.transform({ status: 'PAID' }, meta(SetSaleStatusDto));
    // P5-A2 family 5: the RESOLVED SCOPE leads the call — the service decides
    // which orders exist from it, never from the session user.
    const scope = { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: 's1', allowedStoreIds: ['s1'] };
    const actor = { id: 'u1' };
    await expect(controller.setStatus({ scope, user: actor }, 'foreign-id', validated)).rejects.toThrow(
      'Order not found',
    );
    expect(salesService.setStatus).toHaveBeenCalledWith(scope, actor, 'foreign-id', 'PAID');
  });
});
