import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { SettingsController } from '../settings.controller';
import { SettingsService } from '../settings.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

describe('SettingsController', () => {
  let controller: SettingsController;
  let service: SettingsService;
  let reflector: Reflector;

  beforeEach(async () => {
    const mockService = {
      getSettings: jest.fn().mockResolvedValue({
        id: 'settings-uuid',
        singletonKey: 'global',
        currency: 'USD',
        timezone: 'UTC',
      }),
      updateSettings: jest.fn().mockResolvedValue({
        id: 'settings-uuid',
        singletonKey: 'global',
        companyName: 'New name',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        {
          provide: SettingsService,
          useValue: mockService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SettingsController>(SettingsController);
    service = module.get<SettingsService>(SettingsService);
    reflector = module.get<Reflector>(Reflector);
  });

  it('should call getSettings on the service and return data', async () => {
    const result = await controller.getSettings();
    expect(result).toEqual({
      data: expect.objectContaining({
        singletonKey: 'global',
      }),
    });
    expect(service.getSettings).toHaveBeenCalled();
  });

  it('should call updateSettings on the service and return data', async () => {
    const dto = { companyName: 'New name' };
    const req = { user: { id: 'user-uuid', email: 'admin@example.com' } };
    const result = await controller.updateSettings(req, dto);

    expect(result).toEqual({
      data: expect.objectContaining({
        companyName: 'New name',
      }),
    });
    expect(service.updateSettings).toHaveBeenCalledWith(dto, req.user);
  });

  it('should be protected by guards', () => {
    const guards = Reflect.getMetadata('__guards__', SettingsController);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RolesGuard);
  });

  it('lets tenant admins READ platform settings but never WRITE them (P0-09)', () => {
    const getRoles = reflector.get<string[]>('roles', controller.getSettings);
    expect(getRoles).toEqual(['SUPER_ADMIN', 'ADMIN']);

    // A client admin editing the platform announcement would broadcast to
    // every other client — writing is platform-only
    const updateRoles = reflector.get<string[]>('roles', controller.updateSettings);
    expect(updateRoles).toEqual(['SUPER_ADMIN']);
  });
});
