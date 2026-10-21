import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule, ThrottlerStorage, Throttle } from '@nestjs/throttler';
// Deep imports: these are not re-exported at the @nestjs/throttler root.
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import * as request from 'supertest';

import { AuthController } from '../../modules/auth/auth.controller';
import { PublicCatalogueController } from '../../modules/public-catalogue/public-catalogue.controller';

/**
 * #181 regression: swapping the throttler STORAGE must not change the tuned
 * per-route limits, the single `default` bucket, or the one-increment-per-request
 * behaviour. If the bucket were renamed, every @Throttle({ default: ... }) would
 * silently stop applying — so we assert both the preserved values and the live
 * enforcement.
 */
describe('#181 throttle overrides are preserved', () => {
  describe('declared limits on the real handlers (values unchanged)', () => {
    it('login stays 5 requests / 60s', () => {
      expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', AuthController.prototype.login)).toBe(5);
      expect(Reflect.getMetadata(THROTTLER_TTL + 'default', AuthController.prototype.login)).toBe(60_000);
    });

    it('public order creation stays 10 requests / 60s', () => {
      expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', PublicCatalogueController.prototype.createOrder)).toBe(
        10,
      );
      expect(Reflect.getMetadata(THROTTLER_TTL + 'default', PublicCatalogueController.prototype.createOrder)).toBe(
        60_000,
      );
    });
  });

  describe('live enforcement through the real ThrottlerGuard', () => {
    // A minimal but correct storage: real blocking so a 429 can be observed, and
    // a call counter so we can prove exactly one increment per request.
    class CountingStorage implements ThrottlerStorage {
      public calls = 0;
      private readonly hits = new Map<string, number>();

      async increment(key: string, ttl: number, limit: number, blockDuration: number): Promise<ThrottlerStorageRecord> {
        this.calls += 1;
        const totalHits = (this.hits.get(key) ?? 0) + 1;
        this.hits.set(key, totalHits);
        const isBlocked = totalHits > limit;
        return {
          totalHits,
          timeToExpire: Math.ceil(ttl / 1000),
          isBlocked,
          timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
        };
      }
    }

    @Controller('t')
    class ProbeController {
      @Get('plain')
      plain() {
        return 'ok';
      }

      @Throttle({ default: { limit: 2, ttl: 60_000 } })
      @Get('limited')
      limited() {
        return 'ok';
      }
    }

    let app: INestApplication;
    let storage: CountingStorage;

    beforeEach(async () => {
      storage = new CountingStorage();
      const moduleRef = await Test.createTestingModule({
        imports: [
          ThrottlerModule.forRoot({
            throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
            storage,
          }),
        ],
        controllers: [ProbeController],
        providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('increments the store exactly once per request (single default throttler)', async () => {
      const server = app.getHttpServer();
      await request(server).get('/t/plain').expect(200);
      await request(server).get('/t/plain').expect(200);
      await request(server).get('/t/plain').expect(200);
      expect(storage.calls).toBe(3);
    });

    it('enforces a @Throttle({ default }) override: the 3rd call over limit 2 is 429', async () => {
      const server = app.getHttpServer();
      await request(server).get('/t/limited').expect(200);
      await request(server).get('/t/limited').expect(200);
      await request(server).get('/t/limited').expect(429);
    });
  });
});
