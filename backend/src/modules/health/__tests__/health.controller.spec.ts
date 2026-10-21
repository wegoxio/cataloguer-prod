import { HealthController } from '../health.controller';
import { ServiceUnavailableException } from '@nestjs/common';

describe('HealthController', () => {
  let controller: HealthController;
  const execute = jest.fn();

  beforeEach(() => {
    execute.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    controller = new HealthController({ em: { getConnection: () => ({ execute }) } } as never);
  });

  it('returns healthy only after PostgreSQL answers', async () => {
    await expect(controller.check()).resolves.toEqual({ status: 'ok', database: 'ok' });
    expect(execute).toHaveBeenCalledWith('select 1');
  });

  it('returns 503 without leaking the database error', async () => {
    execute.mockRejectedValueOnce(new Error('secret connection detail'));
    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
