import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

// Control the adapter so the wrapper is tested in isolation (no real Redis).
const mockIncrement = jest.fn();
jest.mock('@nest-lab/throttler-storage-redis', () => ({
  ThrottlerStorageRedisService: jest.fn().mockImplementation(() => ({
    increment: mockIncrement,
  })),
}));

import { ResilientThrottlerStorage } from './resilient-throttler.storage';
import { REDIS_QUIT_TIMEOUT_MS } from './rate-limit.constants';

const record = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };

function makeConfig(prefix: string | undefined): ConfigService {
  return { get: jest.fn(() => prefix) } as unknown as ConfigService;
}

function makeClient(): { quit: jest.Mock; disconnect: jest.Mock } & Redis {
  return { quit: jest.fn(), disconnect: jest.fn() } as unknown as {
    quit: jest.Mock;
    disconnect: jest.Mock;
  } & Redis;
}

describe('ResilientThrottlerStorage', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('increment', () => {
    it('prepends RATE_LIMIT_KEY_PREFIX to the key before delegating', async () => {
      mockIncrement.mockResolvedValue(record);
      const storage = new ResilientThrottlerStorage(makeClient(), makeConfig('cataloguer:test:'));

      await storage.increment('abc123', 60_000, 100, 0, 'default');

      expect(mockIncrement).toHaveBeenCalledWith('cataloguer:test:abc123', 60_000, 100, 0, 'default');
    });

    it('maps any Redis error to a 503 that leaks no connection detail', async () => {
      mockIncrement.mockRejectedValue(new Error('connect ECONNREFUSED rediss://secret@host'));
      const storage = new ResilientThrottlerStorage(makeClient(), makeConfig('cataloguer:test:'));

      const err = await storage.increment('k', 1, 1, 0, 'default').catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getStatus()).toBe(503);
      expect(err.message).toBe('Rate limiting temporarily unavailable');
      expect(err.message).not.toMatch(/rediss?:\/\/|host|ECONNREFUSED/);
    });

    it('fails closed with a 503 when there is no client (memory mode wiring)', async () => {
      const storage = new ResilientThrottlerStorage(null, makeConfig('cataloguer:test:'));
      await expect(storage.increment('k', 1, 1, 0, 'default')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockIncrement).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('closes gracefully with quit() and does not force-disconnect', async () => {
      const client = makeClient();
      client.quit.mockResolvedValue('OK');
      const storage = new ResilientThrottlerStorage(client, makeConfig('p:'));

      await storage.onModuleDestroy();

      expect(client.quit).toHaveBeenCalledTimes(1);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('force-disconnects when the graceful quit() fails', async () => {
      const client = makeClient();
      client.quit.mockRejectedValue(new Error('outage'));
      const storage = new ResilientThrottlerStorage(client, makeConfig('p:'));

      await storage.onModuleDestroy();

      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('force-disconnects when quit() hangs past the bounded timeout', async () => {
      jest.useFakeTimers();
      const client = makeClient();
      client.quit.mockReturnValue(new Promise(() => {})); // never settles
      const storage = new ResilientThrottlerStorage(client, makeConfig('p:'));

      const done = storage.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(REDIS_QUIT_TIMEOUT_MS + 10);
      await done;

      expect(client.disconnect).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('is idempotent — a second call does not quit again', async () => {
      const client = makeClient();
      client.quit.mockResolvedValue('OK');
      const storage = new ResilientThrottlerStorage(client, makeConfig('p:'));

      await storage.onModuleDestroy();
      await storage.onModuleDestroy();

      expect(client.quit).toHaveBeenCalledTimes(1);
    });

    it('no-ops without a client (memory mode)', async () => {
      const storage = new ResilientThrottlerStorage(null, makeConfig('p:'));
      await expect(storage.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
