import { ExportsController } from '../exports.controller';
import { ExportsService } from '../exports.service';
import type { Response } from 'express';

describe('ExportsController', () => {
  let controller: ExportsController;
  let service: ExportsService;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    service = {
      exportCategories: jest.fn().mockResolvedValue('name,slug,description,parentSlug\n'),
      exportProducts: jest.fn().mockResolvedValue('name,slug,description,sku,price,status\n'),
    } as any;

    mockRes = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    controller = new ExportsController(service);
  });

  it('should call exportCategories and set headers correctly', async () => {
    await controller.exportCategories({ scope: { organizationId: 'org-1' } } as any, mockRes as Response);

    expect(service.exportCategories).toHaveBeenCalledWith('org-1');
    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="categories.csv"');
    expect(mockRes.send).toHaveBeenCalledWith('name,slug,description,parentSlug\n');
  });

  it('should call exportProducts and set headers correctly', async () => {
    await controller.exportProducts({ scope: { organizationId: 'org-1' } } as any, mockRes as Response);

    expect(service.exportProducts).toHaveBeenCalledWith('org-1');
    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="products.csv"');
    expect(mockRes.send).toHaveBeenCalledWith('name,slug,description,sku,price,status\n');
  });
});
