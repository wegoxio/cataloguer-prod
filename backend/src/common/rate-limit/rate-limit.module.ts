import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RATE_LIMIT_REDIS_CLIENT } from './rate-limit.constants';
import { createRateLimitRedisClient } from './redis-client.factory';
import { ResilientThrottlerStorage } from './resilient-throttler.storage';

/**
 * Owns the distributed rate-limit store (#181): the ioredis client (null in
 * memory mode) and the resilient storage wrapper.
 *
 * Registering the wrapper as a real provider here — rather than only handing it
 * to ThrottlerModule as an options value — guarantees Nest invokes its
 * onModuleDestroy on shutdown, so the Redis client is always closed cleanly.
 * ConfigModule is global, so ConfigService is injectable without importing it.
 */
@Module({
  providers: [
    {
      provide: RATE_LIMIT_REDIS_CLIENT,
      useFactory: createRateLimitRedisClient,
      inject: [ConfigService],
    },
    ResilientThrottlerStorage,
  ],
  exports: [ResilientThrottlerStorage],
})
export class RateLimitModule {}
