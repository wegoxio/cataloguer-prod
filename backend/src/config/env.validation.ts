import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { RateLimitMode } from '../common/rate-limit/rate-limit.constants';
import { IsRedisUrl } from '../common/validation/is-redis-url.validator';
import { parseRevalidationTargets } from '../common/catalogue-revalidation/revalidation-targets';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
  Staging = 'staging',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @Type(() => Number)
  @IsNumber()
  PORT = 3001;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  CORS_ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:3001';

  // S3-compatible object storage (AWS S3 or Cloudflare R2) — ADR 006
  @IsString()
  @IsOptional()
  STORAGE_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  STORAGE_REGION?: string;

  @IsString()
  @IsOptional()
  STORAGE_BUCKET?: string;

  // The storage URL allowlist (#174) anchors on this value, so a present
  // value must be a real http(s) URL or the boot fails — a typo here would
  // otherwise silently reject every image registration at runtime.
  // Empty/absent stays allowed: storage-less environments fail closed.
  @ValidateIf((o) => o.STORAGE_PUBLIC_URL !== undefined && o.STORAGE_PUBLIC_URL !== '')
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false },
    { message: 'STORAGE_PUBLIC_URL must be an http(s) URL' },
  )
  STORAGE_PUBLIC_URL?: string;

  @IsString()
  @IsOptional()
  STORAGE_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  STORAGE_SECRET_ACCESS_KEY?: string;

  // Email (Resend) + reset-link base — optional; unconfigured = emails dropped with a log
  @IsString()
  @IsOptional()
  RESEND_API_KEY?: string;

  @IsString()
  @IsOptional()
  MAIL_FROM?: string;

  @IsString()
  @IsOptional()
  FRONTEND_URL?: string;

  // Signed fan-out to connected storefronts. JSON is structurally validated
  // below after class-validator has established that it is a string.
  @IsString()
  @IsOptional()
  CATALOGUE_REVALIDATION_TARGETS?: string;

  @IsString()
  @IsOptional()
  DEV_ADMIN_EMAIL?: string;

  @IsString()
  @IsOptional()
  DEV_ADMIN_PASSWORD?: string;

  // Import upload hardening (#172). The default is the single source of truth;
  // a present-but-invalid value (non-integer, out of range) fails boot, so the
  // limit can never silently degrade. Consumers read the validated number
  // through ConfigService at DI time — never process.env in a decorator.
  @Type(() => Number)
  @IsInt()
  @Min(65536) // 64 KiB — below this no real catalog/supplier CSV fits
  @Max(20971520) // 20 MiB ceiling
  MAX_IMPORT_FILE_BYTES = 5242880; // 5 MiB

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  IMPORT_CONCURRENCY_PERMITS = 4;

  // Phase 9 private source storage. Import sources are tenant documents —
  // prices, costs, customers — and the catalogue asset bucket is publicly
  // readable by design (ADR 006), so they need their own private bucket.
  // Optional here so an environment without imports still boots; the storage
  // service refuses to operate (rather than falling back to the public bucket)
  // when it is unset or equal to STORAGE_BUCKET.
  @IsString()
  @IsOptional()
  IMPORT_SOURCE_BUCKET?: string;

  // Explicit operator affirmation that the bucket above has no public access
  // and no public development URL. Nothing inside the process can observe that,
  // and the cost of assuming it wrongly is publishing tenant documents, so the
  // service stays unavailable until this is exactly "true".
  @IsString()
  @IsOptional()
  IMPORT_SOURCE_BUCKET_PRIVATE?: string;

  // Credentials for the import bucket alone, deliberately separate from the
  // asset-storage ones. A shared token would mean one leak exposes both
  // buckets and would make the access log unable to tell import traffic from
  // product-photo traffic. There is no fallback: absent means imports are
  // unavailable.
  @IsString()
  @IsOptional()
  IMPORT_SOURCE_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  IMPORT_SOURCE_SECRET_ACCESS_KEY?: string;

  // Optional: the account's R2 S3 endpoint, if it differs from STORAGE_ENDPOINT.
  // The endpoint identifies the account rather than the bucket, so sharing it
  // reveals nothing the token does not already imply.
  @IsString()
  @IsOptional()
  IMPORT_SOURCE_ENDPOINT?: string;

  // Opt-in for the local-only /auth/register-dev endpoint (P1-06). Only honored
  // when NODE_ENV=development; unset everywhere else so the endpoint 404s.
  @IsString()
  @IsOptional()
  ALLOW_DEV_REGISTER?: string;

  // Distributed rate limiting (#181). Chooses where the ThrottlerGuard counters
  // live. `distributed-redis` shares the counters across every instance via
  // Redis (the normal scalable config); `memory` is per-instance (local/test or
  // an explicitly approved emergency rollback / single-instance deployment).
  //
  // In production (NODE_ENV=production) the mode MUST be present — a missing
  // value fails validation at boot, so a scaled deployment can never silently
  // boot with per-instance counters. In development/test a missing value
  // defaults to memory (applied in validate() below). NODE_ENV only governs
  // whether omission is allowed; it NEVER selects the mode — the operator does.
  @ValidateIf((o) => o.NODE_ENV === Environment.Production || o.RATE_LIMIT_MODE !== undefined)
  @IsEnum(RateLimitMode)
  RATE_LIMIT_MODE?: RateLimitMode;

  // Redis connection string. Required and strictly validated ONLY in
  // distributed-redis mode; in memory mode a present value is intentionally
  // ignored (preconfiguration / fast mode-only rollback — see RateLimitMode).
  // Non-loopback hosts must use rediss:// (TLS). SECRET — never logged.
  @ValidateIf((o) => o.RATE_LIMIT_MODE === RateLimitMode.DistributedRedis)
  @IsRedisUrl()
  REDIS_URL?: string;

  // Namespace applied to every rate-limit key. Required in distributed-redis
  // mode so environments sharing a Redis database (e.g. staging/production)
  // cannot collide; a present value is ignored in memory mode. Lowercase
  // colon-delimited segments ending in ':' (e.g. cataloguer:staging:).
  @ValidateIf((o) => o.RATE_LIMIT_MODE === RateLimitMode.DistributedRedis)
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?::[a-z0-9]+)*:$/, {
    message: 'RATE_LIMIT_KEY_PREFIX must be lowercase colon-delimited segments ending with ":"',
  })
  RATE_LIMIT_KEY_PREFIX?: string;

  /**
   * P5-X1 — deployment-level maintenance mode.
   *
   * Constrained to the two literals so a typo cannot boot. The guard treats
   * only `on` as maintenance, so without this validation a misspelled value
   * would read as "off" silently — a revision the operator believed was closed
   * would be accepting mutations. Refusing to start is the loud alternative.
   */
  @IsOptional()
  @IsIn(['on', 'off'])
  MAINTENANCE_MODE?: string;

  /**
   * The commit the running image was built from, supplied by the deployment.
   * The cutover job requires the operator's `--expect-source-revision` to match
   * it; it has no effect on the serving application.
   */
  @IsOptional()
  @IsString()
  SOURCE_REVISION?: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, { skipMissingProperties: false });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  // Outside production a missing mode defaults to memory; in production it is
  // required above, so it is always explicit by the time we reach here. NODE_ENV
  // never selects the mode — it only decides whether omission is allowed.
  if (validatedConfig.RATE_LIMIT_MODE === undefined) {
    validatedConfig.RATE_LIMIT_MODE = RateLimitMode.Memory;
  }
  parseRevalidationTargets(
    validatedConfig.CATALOGUE_REVALIDATION_TARGETS,
    validatedConfig.NODE_ENV === Environment.Production,
  );
  return validatedConfig;
}
