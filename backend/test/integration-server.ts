import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { AddressInfo } from 'net';
import { withDisposablePg, DisposablePg } from './pg-harness';
import { startFakeObjectStore, FakeObjectStore } from './fake-object-store';

/**
 * A whole running Cataloguer, for one integrated journey.
 *
 * The frontend's own tests answer "does the wizard behave" against a scripted
 * server. That is worth having and it is not enough: a scripted server agrees
 * with whatever the frontend expects, so the two can drift apart in perfect
 * mutual confidence and nobody finds out until a customer tries it.
 *
 * So this stands up the real thing — real Nest routes, real guards, real
 * validation pipe, real MikroORM against a real disposable PostgreSQL, real
 * S3 client against a fake object store at the provider boundary — and prints
 * one line of JSON telling a test how to reach it.
 *
 * It is a test harness that lives in the repository rather than a script
 * written on the day, for the same reason the runner job does: the alternative
 * is somebody inventing one under pressure.
 *
 * Run as `node dist/test/integration-server.js`. It prints its JSON line, then
 * waits. SIGTERM drops the disposable database and exits.
 */

const BUCKET = 'cataloguer-import-sources-integration';
const PASSWORD = 'Integration-Journey-1!';

interface Handle {
  app: INestApplication;
  pg: DisposablePg;
  store: FakeObjectStore;
}

/**
 * The disposable database, held from the moment it exists.
 *
 * Everything after `withDisposablePg` can throw — a migration, a boot failure,
 * a port already in use — and until the shutdown hook is installed there was
 * nothing to drop it. That leaked one database per failed run, which fills a
 * developer's PostgreSQL with `cataloguer_test_*` and gets the whole approach
 * abandoned. So the handle is module-scoped and the failure path drops it.
 */
let disposable: DisposablePg | null = null;

async function main(): Promise<void> {
  // Point the migrator at THIS build's compiled migrations before anything
  // initialises the ORM.
  //
  // The shipped config names `dist/database/migrations` with a TypeScript
  // fallback of `src/database/migrations`. Neither is right here: this harness
  // compiles to `dist-integration/`, and left alone the migrator picks the
  // TypeScript path and then fails the moment one migration imports another,
  // because a `.ts` sibling cannot be required from compiled JavaScript.
  const databaseConfig = (await import('../src/database/mikro-orm.config')).default as {
    clientUrl?: string;
    migrations?: { path?: string; pathTs?: string };
  };
  if (databaseConfig.migrations) {
    databaseConfig.migrations.path = `${__dirname}/../src/database/migrations`;
    delete databaseConfig.migrations.pathTs;
  }

  const pg = await withDisposablePg();
  disposable = pg;
  const store = await startFakeObjectStore();

  const databaseUrl = (() => {
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${pg.dbName}`;
    return url.toString();
  })();

  // Set BEFORE the application module is loaded: the config module reads the
  // environment once, at boot.
  process.env.DATABASE_URL = databaseUrl;
  process.env.IMPORT_SOURCE_BUCKET = BUCKET;
  process.env.IMPORT_SOURCE_BUCKET_PRIVATE = 'true';
  process.env.IMPORT_SOURCE_ACCESS_KEY_ID = 'integration-access-key';
  process.env.IMPORT_SOURCE_SECRET_ACCESS_KEY = 'integration-secret-key';
  process.env.IMPORT_SOURCE_ENDPOINT = store.endpoint;
  process.env.STORAGE_REGION = 'auto';
  process.env.JWT_ACCESS_SECRET ??= `integration-access-${randomUUID()}`;
  process.env.JWT_REFRESH_SECRET ??= `integration-refresh-${randomUUID()}`;
  // In-process counters, which is what a single-instance test server should
  // use. The journey signs in twice, well inside the login budget.
  process.env.RATE_LIMIT_MODE = 'memory';

  // The ORM config captures `process.env.DATABASE_URL` when its module is
  // first evaluated, which has already happened. The config object is a
  // singleton, so pointing it at the disposable database is what actually
  // takes effect — and it must happen before the application module loads.
  databaseConfig.clientUrl = databaseUrl;

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: ['error'] });

  // The SAME pipe configuration the server runs with. A test server that
  // validated differently would prove nothing about the real one.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: true, credentials: true });

  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  const seed = await seedTwoCompanies(app.get(MikroORM).em.fork() as EntityManager);

  const handle: Handle = { app, pg, store };
  installShutdown(handle);

  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      apiUrl: `http://127.0.0.1:${port}/api/v1`,
      storeEndpoint: store.endpoint,
      bucket: BUCKET,
      // The disposable database's NAME, never its connection string. A caller
      // that needs to reach it already holds `TEST_DATABASE_URL` — which is how
      // it reached this harness — and can point that at this name. Printing the
      // full URL would put credentials in a log for no gain.
      databaseName: pg.dbName,
      accessKeyId: 'integration-access-key',
      secretAccessKey: 'integration-secret-key',
      password: PASSWORD,
      ...seed,
    })}\n`,
  );
}

/**
 * Two companies, because half the properties worth proving are about the
 * boundary between them.
 *
 * Each gets a manager who can import and two shops. Nothing about the import
 * lifecycle is seeded — no source, no analysis, no plan. Those must come from
 * the routes, or the journey would be proving the fixture rather than the
 * product.
 */
async function seedTwoCompanies(em: EntityManager) {
  const passwordHash = await argon2.hash(PASSWORD);

  const company = async (label: string) => {
    const organizationId = (
      await em.getConnection().execute<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, now(), now()) returning id`,
        [label, `${label}-${randomUUID().slice(0, 8)}`.toLowerCase()],
      )
    )[0].id;

    const store = async (name: string) => {
      const id = (
        await em.getConnection().execute<{ id: string }[]>(
          `insert into stores (id, name, slug, organization_id, created_at, updated_at)
           values (gen_random_uuid(), ?, ?, ?, now(), now()) returning id`,
          [name, `${name}-${randomUUID().slice(0, 8)}`, organizationId],
        )
      )[0].id;
      await em.getConnection().execute(
        `insert into inventory_locations (id, organization_id, code, name, kind, store_id, is_default, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?, 'STORE', ?, false, now(), now())`,
        [organizationId, `STORE:${id}`, name, id],
      );
      return id;
    };

    const warehouseId = (
      await em.getConnection().execute<{ id: string }[]>(
        `insert into inventory_locations (id, organization_id, code, name, kind, is_default, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, 'Almacén', 'WAREHOUSE', true, now(), now()) returning id`,
        [organizationId, `WAREHOUSE:${organizationId}`],
      )
    )[0].id;

    const email = `manager-${randomUUID().slice(0, 8)}@example.test`;
    const userId = (
      await em.getConnection().execute<{ id: string }[]>(
        `insert into users
           (id, email, password_hash, first_name, last_name, organization_id, role_id, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, 'Ana', 'Ruiz', ?,
                 (select id from roles where name = 'ORGANIZATION_MANAGER' limit 1), now(), now())
         returning id`,
        [email, passwordHash, organizationId],
      )
    )[0].id;

    return {
      organizationId,
      userId,
      email,
      warehouseId,
      centro: await store('centro'),
      norte: await store('norte'),
    };
  };

  return { ours: await company('Integration Co'), theirs: await company('Somebody Else') };
}

/**
 * Drop the disposable database whatever happens.
 *
 * A harness that leaked a database per run would fill a developer's PostgreSQL
 * with `cataloguer_test_*` within a week, which is the kind of mess that gets a
 * whole approach abandoned.
 */
function installShutdown({ app, pg, store }: Handle): void {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch {
      /* the port is going away regardless */
    }
    try {
      await store.close();
    } catch {
      /* likewise */
    }
    await pg.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  // The parent test process dying must not leave the database behind.
  process.on('disconnect', () => void shutdown());
}

void main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  try {
    await disposable?.close();
  } catch (cleanupError) {
    // Reported, never allowed to replace the real error: a failure to tidy up
    // must not hide what actually went wrong.
    process.stderr.write(`and the disposable database could not be dropped: ${String(cleanupError)}\n`);
  }
  process.exit(1);
});
