import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ChangePasswordDto } from '../../modules/auth/dto/change-password.dto';

describe('password policy', () => {
  const check = async (newPassword: string) => {
    const dto = plainToInstance(ChangePasswordDto, { currentPassword: 'whatever', newPassword });
    const errors = await validate(dto);
    return errors.length === 0;
  };

  it('rejects the weak passwords that motivated the policy', async () => {
    expect(await check('elitetogo123!')).toBe(false); // no uppercase
    expect(await check('Elite123!')).toBe(false); // too short
    expect(await check('EliteToGoPass!')).toBe(false); // no number
    expect(await check('ELITETOGO123!')).toBe(false); // no lowercase
    expect(await check('EliteToGo1234')).toBe(false); // no symbol
  });

  it('accepts passwords meeting the policy', async () => {
    expect(await check('EliteToGo123!')).toBe(true);
    expect(await check('Wegox-Catalog-2026')).toBe(true);
  });
});
