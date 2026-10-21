import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  RateLimitMode,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_MAX_RECONNECT_ATTEMPTS,
  REDIS_PING_TIMEOUT_MS,
  withTimeout,
} from './rate-limit.constants';

/**
 * Builds the ioredis client for distributed rate limiting (#181), or null in
 * memory mode — where no client is constructed or contacted.
 *
 * Fails closed at startup: if the client cannot connect and answer PING within
 * bounded timeouts, it is disconnected and an error is thrown, so an instance
 * never boots able to accept traffic without a working shared limiter. The
 * runtime options (bounded command timeout, single retry, no offline queue)
 * make a later outage fail closed too — commands reject rather than buffer.
 */
export async function createRateLimitRedisClient(config: ConfigService): Promise<Redis | null> {
  const mode = config.get<RateLimitMode>('RATE_LIMIT_MODE');
  if (mode !== RateLimitMode.DistributedRedis) {
    return null;
  }

  const logger = new Logger('RateLimitRedis');
  // Present and validated (env.validation) whenever the mode is distributed.
  const url = config.get<string>('REDIS_URL') as string;

  const client = new Redis(url, {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    // Surface failures to the caller (→ HTTP 503) instead of buffering commands
    // or retrying a request forever; this is what makes a runtime outage fail
    // closed rather than silently letting requests through unmetered.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    // Connect explicitly below so a startup failure is catchable here.
    lazyConnect: true,
    // Bounded background reconnection; returning null stops further attempts.
    retryStrategy: (times) => (times > REDIS_MAX_RECONNECT_ATTEMPTS ? null : Math.min(times * 200, 2_000)),
    // TLS is enabled automatically for the rediss:// scheme.
  });

  // Without an 'error' listener ioredis rethrows connection errors as uncaught
  // exceptions. Log only the error CODE — never the message (which can echo host
  // details) and never the URL (which carries credentials).
  client.on('error', (err: NodeJS.ErrnoException) => {
    logger.warn(`Redis connection error: ${err?.code ?? 'unknown'}`);
  });

  try {
    await withTimeout(client.connect(), REDIS_CONNECT_TIMEOUT_MS + 1_000, 'redis connect');
    await withTimeout(client.ping(), REDIS_PING_TIMEOUT_MS, 'redis ping');
  } catch {
    // Disconnect the newly created, still-reconnecting client before rethrowing,
    // so a failed bootstrap never leaks a background reconnect loop.
    client.disconnect();
    throw new Error('Rate-limit Redis is not reachable at startup (failing closed)');
  }

  logger.log('Distributed rate-limit store connected');
  return client;
}
