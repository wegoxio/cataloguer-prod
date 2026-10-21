import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CheckoutDto } from '../checkout.dto';
import { PLANS } from '../../../stores/plans';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

describe('CheckoutDto (#173)', () => {
  it('accepts every plan a tenant may choose', async () => {
    for (const plan of Object.keys(PLANS).filter((key) => PLANS[key].offeredToTenants)) {
      await expect(pipe.transform({ plan }, meta(CheckoutDto))).resolves.toBeDefined();
    }
  });

  it('refuses Plan Gratis, which only the platform owner assigns', async () => {
    await expect(pipe.transform({ plan: 'GRATIS' }, meta(CheckoutDto))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown plan and unknown fields', async () => {
    await expect(pipe.transform({ plan: 'FREE' }, meta(CheckoutDto))).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ plan: 'BASICO', evil: 1 }, meta(CheckoutDto))).rejects.toThrow();
    await expect(pipe.transform({}, meta(CheckoutDto))).rejects.toThrow();
  });
});
