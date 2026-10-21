import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuthController } from '../../auth.controller';

/**
 * #160/P1-06: /auth/register-dev must fail closed. It is only reachable with
 * NODE_ENV=development AND ALLOW_DEV_REGISTER=true; everything else 404s. It
 * can never mint a SUPER_ADMIN — and since #156 it can never mint an UNSCOPED
 * tenant user either: the store is mandatory and the user is created inside
 * it, organization derived from the store by the service.
 */
describe('POST /auth/register-dev (P1-06 + #156)', () => {
  const build = (env: Record<string, string | undefined>) => {
    const users = {
      findByEmail: jest.fn().mockResolvedValue(null),
      createUserInStore: jest.fn(async ({ email, roleName }: any) => ({
        id: 'u1',
        email,
        role: { name: roleName },
      })),
    };
    const config = { get: (key: string) => env[key] };
    const controller = new AuthController({} as any, users as any, config as any);
    return { controller, users };
  };

  const dto = { email: 'dev@local.test', password: 'Password123!', storeId: 'store-1' } as any;

  it('404s when the explicit flag is missing, even in development', async () => {
    const { controller, users } = build({ NODE_ENV: 'development', ALLOW_DEV_REGISTER: undefined });

    await expect(controller.registerDev(dto)).rejects.toThrow(NotFoundException);
    expect(users.createUserInStore).not.toHaveBeenCalled();
  });

  it('404s in staging even if the flag is somehow set', async () => {
    const { controller, users } = build({ NODE_ENV: 'staging', ALLOW_DEV_REGISTER: 'true' });

    await expect(controller.registerDev(dto)).rejects.toThrow(NotFoundException);
    expect(users.createUserInStore).not.toHaveBeenCalled();
  });

  it('404s in production', async () => {
    const { controller } = build({ NODE_ENV: 'production', ALLOW_DEV_REGISTER: 'true' });

    await expect(controller.registerDev(dto)).rejects.toThrow(NotFoundException);
  });

  it('creates the user INSIDE the given store with NODE_ENV=development AND the flag on', async () => {
    const { controller, users } = build({ NODE_ENV: 'development', ALLOW_DEV_REGISTER: 'true' });

    const res = await controller.registerDev({ ...dto, role: 'ADMIN' });

    expect(users.createUserInStore).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'dev@local.test', roleName: 'ADMIN', storeId: 'store-1' }),
    );
    expect(res.data.role).toBe('ADMIN');
  });

  it('defaults to EDITOR when no role is given', async () => {
    const { controller, users } = build({ NODE_ENV: 'development', ALLOW_DEV_REGISTER: 'true' });

    await controller.registerDev(dto);

    expect(users.createUserInStore).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'EDITOR' }));
  });

  it('rejects a duplicate email before creating anything', async () => {
    const { controller, users } = build({ NODE_ENV: 'development', ALLOW_DEV_REGISTER: 'true' });
    users.findByEmail.mockResolvedValue({ id: 'existing' });

    await expect(controller.registerDev(dto)).rejects.toThrow(BadRequestException);
    expect(users.createUserInStore).not.toHaveBeenCalled();
  });

  it('surfaces the service rejection for an invalid store (#156: no unscoped users)', async () => {
    const { controller, users } = build({ NODE_ENV: 'development', ALLOW_DEV_REGISTER: 'true' });
    users.createUserInStore.mockRejectedValue(new BadRequestException('Store not found'));

    await expect(controller.registerDev(dto)).rejects.toThrow('Store not found');
  });

  // SUPER_ADMIN is blocked at the DTO layer (class-validator @IsIn), so it can
  // never reach the handler — this documents the intent at the unit boundary.
  // The DTO also REQUIRES storeId (@IsUUID), so an unscoped request never
  // reaches the handler either.
  it('the role whitelist excludes SUPER_ADMIN and the DTO requires a store', async () => {
    const { REGISTER_DEV_ROLES, RegisterDevDto } = await import('../../dto/register-dev.dto');
    expect(REGISTER_DEV_ROLES).not.toContain('SUPER_ADMIN');
    expect([...REGISTER_DEV_ROLES]).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);

    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const withoutStore = plainToInstance(RegisterDevDto, { email: 'a@b.c', password: 'Password123!' });
    const errors = await validate(withoutStore as object);
    expect(errors.some((e) => e.property === 'storeId')).toBe(true);
  });
});
