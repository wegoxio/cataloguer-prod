import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

// Explicit mock so the default export is a controllable constructor.
const mockRedisCtor = jest.fn();
jest.mock('ioredis', () => ({
  __esModule: true,
  default: mockRedisCtor,
  Cluster: jest.fn(),
}));

import { RATE_LIMIT_REDIS_CLIENT } from './rate-limit.constants';
import { createRateLimitRedisClient } from './redis-client.factory';
import { RateLimitModule } from './rate-limit.module';
import { ResilientThrottlerStorage } from './resilient-throttler.storage';

function makeConfig(values: Record<string, string>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function mockRedisInstance(overrides: Record<string, jest.Mock> = {}) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    ...overrides,
  };
}

describe('createRateLimitRedisClient', () => {
  beforeEach(() => mockRedisCtor.mockReset());

  it('returns null and constructs no client in memory mode', async () => {
    const client = await createRateLimitRedisClient(makeConfig({ RATE_LIMIT_MODE: 'memory' }));
    expect(client).toBeNull();
    expect(mockRedisCtor).not.toHaveBeenCalled();
  });

  it('connects and PINGs in distributed mode, returning the client', async () => {
    const instance = mockRedisInstance();
    mockRedisCtor.mockImplementation(() => instance);

    const client = await createRateLimitRedisClient(
      makeConfig({ RATE_LIMIT_MODE: 'distributed-redis', REDIS_URL: 'redis://127.0.0.1:6379' }),
    );

    expect(client).toBe(instance);
    expect(instance.connect).toHaveBeenCalledTimes(1);
    expect(instance.ping).toHaveBeenCalledTimes(1);
    expect(instance.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects and throws (fail closed) when the startup connect fails', async () => {
    const instance = mockRedisInstance({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    mockRedisCtor.mockImplementation(() => instance);

    await expect(
      createRateLimitRedisClient(
        makeConfig({ RATE_LIMIT_MODE: 'distributed-redis', REDIS_URL: 'redis://127.0.0.1:6379' }),
      ),
    ).rejects.toThrow(/failing closed/);
    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects and throws (fail closed) when the startup PING fails', async () => {
    const instance = mockRedisInstance({ ping: jest.fn().mockRejectedValue(new Error('timeout')) });
    mockRedisCtor.mockImplementation(() => instance);

    await expect(
      createRateLimitRedisClient(
        makeConfig({ RATE_LIMIT_MODE: 'distributed-redis', REDIS_URL: 'redis://127.0.0.1:6379' }),
      ),
    ).rejects.toThrow(/failing closed/);
    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('RateLimitModule wiring', () => {
  beforeEach(() => mockRedisCtor.mockReset());

  it('provides a null client in memory mode and runs onModuleDestroy on shutdown', async () => {
    // A global stub supplies ConfigService the way the real (global) ConfigModule
    // does, so the real RateLimitModule is exercised end to end.
    @Global()
    @Module({
      providers: [{ provide: ConfigService, useValue: makeConfig({ RATE_LIMIT_MODE: 'memory' }) }],
      exports: [ConfigService],
    })
    class ConfigStubModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigStubModule, RateLimitModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(RATE_LIMIT_REDIS_CLIENT)).toBeNull();
    expect(mockRedisCtor).not.toHaveBeenCalled();

    const storage = moduleRef.get(ResilientThrottlerStorage);
    const destroySpy = jest.spyOn(storage, 'onModuleDestroy');

    await moduleRef.close();

    expect(destroySpy).toHaveBeenCalled();
  });
});
