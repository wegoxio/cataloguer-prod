import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { DashboardMetricsController } from '../dashboard-metrics.controller';
import { DashboardMetricsService } from '../dashboard-metrics.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

describe('DashboardMetricsController', () => {
  let controller: DashboardMetricsController;
  let service: DashboardMetricsService;
  let reflector: Reflector;

  beforeEach(async () => {
    const mockService = {
      getMetrics: jest.fn().mockResolvedValue({
        categories: { total: 10, active: 8, archived: 2 },
        products: { total: 20, draft: 5, published: 12, archived: 3 },
        images: { total: 30, active: 25, archived: 5 },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DashboardMetricsController],
      providers: [
        {
          provide: DashboardMetricsService,
          useValue: mockService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DashboardMetricsController>(DashboardMetricsController);
    service = module.get<DashboardMetricsService>(DashboardMetricsService);
    reflector = module.get<Reflector>(Reflector);
  });

  it('should call getMetrics on the service and return metrics', async () => {
    const result = await controller.getMetrics({ scope: { organizationId: 'org-1' } } as any);
    expect(result).toBeDefined();
    expect(service.getMetrics).toHaveBeenCalled();
  });

  it('should be protected by guards', () => {
    const guards = Reflect.getMetadata('__guards__', DashboardMetricsController);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RolesGuard);
  });

  it('restricts access to organization-wide authority (P5-A2 family 7, option A)', () => {
    // ADMIN is gone on purpose: these counts describe the WHOLE company —
    // categories, products and images are organization-owned — so a branch
    // admin is refused here and reads genuine branch figures in Reports.
    const roles = reflector.get<string[]>('roles', controller.getMetrics);
    expect(roles).toEqual(['SUPER_ADMIN', 'ORGANIZATION_MANAGER']);
    expect(roles).not.toContain('ADMIN');
  });
});
