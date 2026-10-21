import { Inject, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
// Deep import: ThrottlerStorageRecord is not re-exported at the package root.
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { RATE_LIMIT_REDIS_CLIENT, REDIS_QUIT_TIMEOUT_MS, withTimeout } from './rate-limit.constants';

/**
 * Wraps the Redis throttler storage (#181) to add two guarantees the raw
 * adapter does not provide:
 *
 *  1. Namespace isolation — the configured RATE_LIMIT_KEY_PREFIX is prepended
 *     to every key before it reaches Redis, so two environments sharing a
 *     database (e.g. staging and production) can never touch one another's
 *     counters. Prepending to the key here is deterministic regardless of how
 *     the adapter shapes its own Redis key around it.
 *
 *  2. Fail-closed behaviour — any Redis error becomes a controlled HTTP 503
 *     (ServiceUnavailableException) rather than a silently-allowed request or a
 *     throttling 429. The message never contains connection details.
 *
 * It also owns the ioredis client lifecycle: the underlying adapter only closes
 * clients it created itself, and here the client is injected, so this wrapper
 * closes it on shutdown with a bounded graceful quit and a forced-disconnect
 * fallback.
 */
@Injectable()
export class ResilientThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly inner: ThrottlerStorageRedisService | null;
  private readonly prefix: string;
  private closed = false;

  constructor(
    @Inject(RATE_LIMIT_REDIS_CLIENT) private readonly client: Redis | null,
    config: ConfigService,
  ) {
    this.prefix = config.get<string>('RATE_LIMIT_KEY_PREFIX') ?? '';
    // In memory mode the client is null and no adapter (or connection) exists.
    this.inner = client ? new ThrottlerStorageRedisService(client) : null;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.inner) {
      // Only reachable if this storage were wired without a client. Fail closed
      // rather than silently allow an unmetered request.
      throw new ServiceUnavailableException('Rate limiting is not available');
    }

    try {
      return await this.inner.increment(this.prefix + key, ttl, limit, blockDuration, throttlerName);
    } catch {
      // Never surface Redis/connection detail to the client.
      throw new ServiceUnavailableException('Rate limiting temporarily unavailable');
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Idempotent: the instance may be registered by more than one module
    // (RateLimitModule and ThrottlerModule), so guard against a second call.
    if (this.closed) return;
    this.closed = true;

    const { client } = this;
    if (!client) return;

    try {
      // Graceful, but bounded — quit() can hang while Redis is unreachable.
      await withTimeout(client.quit(), REDIS_QUIT_TIMEOUT_MS, 'redis quit');
      return;
    } catch {
      // Graceful quit failed or timed out — force the socket closed below.
    }

    try {
      client.disconnect();
    } catch {
      // Already ended; nothing to do.
    }
  }
}
