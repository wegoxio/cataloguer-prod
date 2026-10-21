/**
 * Shared primitives for the distributed rate-limit store (#181).
 *
 * The throttler keeps a single `default` bucket and an IP-only tracker; only
 * its *storage* changes between an in-process map (memory mode) and a shared
 * Redis store (distributed-redis mode). These values are consumed by the env
 * schema, the Redis client factory and the resilient storage wrapper.
 */

/** How the global ThrottlerGuard counters are stored. */
export enum RateLimitMode {
  /**
   * In-process counters (the pre-#181 behaviour). Correct only for local/test
   * or a deployment technically pinned to a single instance. When this mode is
   * selected, REDIS_URL and RATE_LIMIT_KEY_PREFIX may be present but are
   * intentionally ignored: no Redis client is constructed or contacted. This
   * is deliberate — it lets an operator preconfigure those variables on a
   * service before the distributed-mode code ships, and later revert the mode
   * alone (fast rollback) without having to remove the secret in the same step.
   */
  Memory = 'memory',
  /** Shared Redis counters, correct across every backend instance. */
  DistributedRedis = 'distributed-redis',
}

/** DI token for the (possibly null) ioredis client used by the limiter. */
export const RATE_LIMIT_REDIS_CLIENT = Symbol('RATE_LIMIT_REDIS_CLIENT');

// Bounded so an unreachable or hung Redis fails fast (closed) rather than
// stalling boot or a request. Milliseconds.
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
export const REDIS_COMMAND_TIMEOUT_MS = 3_000;
export const REDIS_PING_TIMEOUT_MS = 5_000;
export const REDIS_QUIT_TIMEOUT_MS = 3_000;
export const REDIS_MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Reject if `promise` does not settle within `ms`. The timer is always cleared,
 * so a settled promise never leaves a dangling handle. The message never embeds
 * any argument value.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
