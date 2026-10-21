import { Body, Controller, INestApplication, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { IMPORT_COMMIT_BODY_LIMIT, IMPORT_COMMIT_BODY_LIMIT_BYTES, MULTIPART_LIMITS } from './body-limits';

/**
 * The bootstrap in main.ts registers body parsers through Nest's own
 * `useBodyParser`, NOT `app.use(json())`. That distinction is the whole point of
 * this suite: `rawBody: true` makes Nest install a parser that also buffers the
 * raw bytes for the Stripe webhook, and re-registering a bare express parser on
 * top would leave `req.rawBody` undefined — silently breaking signature
 * verification on a route that is live in production.
 */
@Controller('probe')
class ProbeController {
  @Post('raw')
  raw(@Req() req: { rawBody?: Buffer }, @Body() body: unknown) {
    return {
      hasRawBody: Buffer.isBuffer(req.rawBody),
      rawLength: req.rawBody?.length ?? 0,
      parsedKeys: body && typeof body === 'object' ? Object.keys(body as object).length : 0,
    };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('explicit body limits', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Mirror main.ts exactly.
    app = await NestFactory.create<NestExpressApplication>(ProbeModule, {
      rawBody: true,
      logger: false,
    });
    (app as NestExpressApplication).useBodyParser('json', { limit: IMPORT_COMMIT_BODY_LIMIT });
    (app as NestExpressApplication).useBodyParser('urlencoded', {
      extended: true,
      limit: IMPORT_COMMIT_BODY_LIMIT,
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps req.rawBody populated, so Stripe signature verification still works', async () => {
    const payload = { id: 'evt_test', type: 'invoice.paid' };
    const res = await request(app.getHttpServer()).post('/probe/raw').send(payload).expect(201);

    expect(res.body.hasRawBody).toBe(true);
    expect(res.body.rawLength).toBe(Buffer.byteLength(JSON.stringify(payload)));
    expect(res.body.parsedKeys).toBe(2);
  });

  it('accepts a body far larger than the old implicit 100 kB default', async () => {
    // 300 kB: over the old invisible ceiling, well under the stated one. This is
    // the case the legacy importer could not previously serve at 200 rows.
    const rows = Array.from({ length: 300 }, (_, i) => ['x'.repeat(900), String(i)]);
    await request(app.getHttpServer()).post('/probe/raw').send({ rows }).expect(201);
  });

  it('refuses a body over the stated ceiling with a 413 rather than an opaque failure', async () => {
    const oversize = 'y'.repeat(IMPORT_COMMIT_BODY_LIMIT_BYTES + 64 * 1024);
    await request(app.getHttpServer()).post('/probe/raw').send({ oversize }).expect(413);
  });

  it('states multipart limits that bound parts and fields, not just file size', () => {
    // Regression guard: `parts`/`fields` defaulted to Infinity before Phase 9.
    expect(MULTIPART_LIMITS.files).toBe(1);
    expect(MULTIPART_LIMITS.parts).toBeLessThanOrEqual(16);
    expect(MULTIPART_LIMITS.fields).toBeLessThanOrEqual(12);
    expect(MULTIPART_LIMITS.fieldSize).toBeLessThanOrEqual(64 * 1024);
    expect(Number.isFinite(MULTIPART_LIMITS.parts)).toBe(true);
    expect(Number.isFinite(MULTIPART_LIMITS.fields)).toBe(true);
  });

  it('the stated commit ceiling actually holds the row cap the service advertises', () => {
    // Measured: 500 real 45-column rows serialize to ~569 kB. The advertised
    // COMMIT_MAX_ROWS = 500 was unreachable under the old 100 kB default.
    const MEASURED_500_ROW_BYTES = 569 * 1024;
    expect(IMPORT_COMMIT_BODY_LIMIT_BYTES).toBeGreaterThan(MEASURED_500_ROW_BYTES);
  });
});
