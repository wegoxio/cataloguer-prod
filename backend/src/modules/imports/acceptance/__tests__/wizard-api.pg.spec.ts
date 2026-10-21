import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import * as http from 'http';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ImportWizardController } from '../../wizard/wizard.controller';
import { MappingTemplateService } from '../../templates/mapping-template.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

/**
 * The wizard's routes over real HTTP, against a real database.
 *
 * The controller unit spec calls the methods directly, which proves the
 * decisions but not the wiring. This boots the controller behind the SAME
 * global validation pipe the application uses and drives it over a socket, so
 * the things only the pipe can break are covered: the `@Allow()` on
 * transformation options, the `forbidNonWhitelisted` refusal of an unexpected
 * field, and the DTO bounds.
 *
 * Authentication is stubbed at the guard, because what is under test is the
 * request shape rather than the token format — the authority decisions have
 * their own suite, and a real login here would prove the login route works.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

interface Scope {
  platform: boolean;
  role: string;
  organizationId: string | null;
  storeId: string | null;
  allowedStoreIds: string[];
}

d('wizard API over HTTP (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let app: INestApplication;
  let baseUrl: string;
  let organizationId: string;
  let scope: Scope;
  // A real user id, because `created_by_user_id` is a uuid column and a JWT
  // carries a uuid.
  const userId = randomUUID();

  /** A plain HTTP call, so nothing about the transport is faked. */
  const call = (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          },
        },
        (response) => {
          let raw = '';
          response.on('data', (chunk) => (raw += chunk));
          response.on('end', () => {
            let json: Record<string, unknown> = {};
            try {
              json = raw ? JSON.parse(raw) : {};
            } catch {
              json = { raw };
            }
            resolve({ status: response.statusCode ?? 0, json });
          });
        },
      );
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });

  beforeAll(async () => {
    pg = await withDisposablePg();

    organizationId = (
      await pg.orm.em.getConnection().execute<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'API Co', ?, now(), now()) returning id`,
        [`api-co-${Date.now()}`],
      )
    )[0].id;

    scope = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId,
      storeId: null,
      allowedStoreIds: [],
    };

    const moduleRef = await Test.createTestingModule({
      // No MikroOrmModule: the service takes an EntityManager directly, and
      // registering repositories here would pull in ORM wiring this suite is
      // not testing.
      controllers: [ImportWizardController],
      providers: [MappingTemplateService, { provide: EntityManager, useValue: pg.orm.em.fork() }],
    })
      // The request's scope is what the controller reads; the guards' own
      // behaviour is proven in the authority suite.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => {
          const req = ctx.switchToHttp().getRequest();
          req.scope = scope;
          req.user = { id: userId };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // The SAME pipe main.ts installs. Its two settings are the point of this
    // suite: `whitelist` strips undecorated properties and
    // `forbidNonWhitelisted` refuses unexpected ones.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await pg?.close();
  });

  const sample = {
    sheet: 'Productos',
    firstRowNumber: 2,
    headers: ['Nombre', 'Precio'],
    rows: [['  Camiseta  ', ' 1.234,50 ']],
  };

  const mapping = {
    sheet: 'Productos',
    headerRow: 1,
    columns: [
      { columnIndex: 0, header: 'Nombre', field: 'name', transformations: [{ kind: 'TRIM' }], reviewed: true },
      {
        columnIndex: 1,
        header: 'Precio',
        field: 'price',
        transformations: [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }],
        reviewed: true,
      },
    ],
  };

  describe('GET /import/wizard/contract', () => {
    it('serves what this build can do', async () => {
      const { status, json } = await call('GET', '/import/wizard/contract');
      expect(status).toBe(200);
      const data = json.data as Record<string, unknown>;
      expect(typeof data.version).toBe('string');
      expect((data.transformations as unknown[]).length).toBeGreaterThan(5);
      expect(data.supportedTransformations as string[]).toContain('PARSE_DECIMAL');
    });
  });

  describe('POST /import/wizard/preview', () => {
    it('returns the normalized rows and whether the import may run', async () => {
      const { status, json } = await call('POST', '/import/wizard/preview', {
        importType: 'PRODUCTS',
        sample,
        mapping,
      });

      expect(status).toBe(201);
      const data = json.data as Record<string, unknown>;
      const rows = data.rows as { sourceRow: number; values: Record<string, unknown> }[];
      expect(rows[0].sourceRow).toBe(2);
      expect(rows[0].values).toEqual({ name: 'Camiseta', price: 1234.5 });
      expect(data.readiness).toEqual({ allowed: true });
    });

    it('carries transformation OPTIONS through the pipe', async () => {
      // The sharp edge of `whitelist`: a free-form nested object vanishes
      // silently unless it is explicitly allowed. If `@Allow()` were missing,
      // the decimal separator would be stripped and "1.234,50" would parse as
      // 1.23450 rather than 1234.5 — a plausible, wrong number.
      const { json } = await call('POST', '/import/wizard/preview', {
        importType: 'PRODUCTS',
        sample,
        mapping,
      });
      const rows = (json.data as Record<string, unknown>).rows as { values: Record<string, unknown> }[];
      expect(rows[0].values.price).toBe(1234.5);
    });

    it('REFUSES an unexpected field rather than ignoring it', async () => {
      const { status } = await call('POST', '/import/wizard/preview', {
        importType: 'PRODUCTS',
        sample,
        mapping,
        somethingNobodyDeclared: true,
      });
      expect(status).toBe(400);
    });

    it('refuses an import type the schema would not accept', async () => {
      const { status } = await call('POST', '/import/wizard/preview', {
        importType: 'EVERYTHING',
        sample,
        mapping,
      });
      expect(status).toBe(400);
    });

    it('refuses a transformation this build cannot run', async () => {
      const { status } = await call('POST', '/import/wizard/preview', {
        importType: 'PRODUCTS',
        sample,
        mapping: {
          ...mapping,
          columns: [{ columnIndex: 0, header: 'Nombre', field: 'name', transformations: [{ kind: 'RUN_SCRIPT' }] }],
        },
      });
      expect(status).toBe(400);
    });

    it('refuses a mapping pointing past the end of the file', async () => {
      const { status, json } = await call('POST', '/import/wizard/preview', {
        importType: 'PRODUCTS',
        sample,
        mapping: { ...mapping, columns: [{ columnIndex: 7, header: 'Fantasma', field: 'name' }] },
      });
      expect(status).toBe(400);
      expect(String(json.message)).toMatch(/not in the file/);
    });

    it('reports a blocking finding rather than refusing the request', async () => {
      // A duplicate field mapping is a finding about the data, not a malformed
      // request; the editor needs it in the issue list.
      const { status, json } = await call('POST', '/import/wizard/preview', {
        importType: 'PRODUCTS',
        sample,
        mapping: {
          ...mapping,
          columns: [
            { columnIndex: 0, header: 'Nombre', field: 'price', reviewed: true },
            { columnIndex: 1, header: 'Precio', field: 'price', reviewed: true },
          ],
        },
      });
      expect(status).toBe(201);
      const data = json.data as Record<string, unknown>;
      expect((data.readiness as { allowed: boolean }).allowed).toBe(false);
      const issues = data.issues as { code: string }[];
      expect(issues.some((i) => i.code === 'DUPLICATE_FIELD_MAPPING')).toBe(true);
    });
  });

  describe('templates over HTTP', () => {
    let templateId: string;

    it('saves a mapping', async () => {
      const { status, json } = await call('POST', '/import/wizard/templates', {
        name: `Mensual ${randomUUID().slice(0, 8)}`,
        importType: 'PRODUCTS',
        mapping,
        headers: ['Nombre', 'Precio'],
        types: ['TEXT', 'DECIMAL'],
      });
      expect(status).toBe(201);
      const data = json.data as { id: string; version: number };
      expect(data.version).toBe(1);
      templateId = data.id;
    });

    it('lists it back', async () => {
      const { status, json } = await call('GET', '/import/wizard/templates?importType=PRODUCTS');
      expect(status).toBe(200);
      expect((json.data as unknown[]).length).toBeGreaterThan(0);
    });

    it('re-binds it to a file whose columns moved, WITH the drift', async () => {
      const { status, json } = await call('POST', `/import/wizard/templates/${templateId}/apply`, {
        headers: ['Nombre', 'Marca', 'Precio'],
        types: ['TEXT', 'TEXT', 'DECIMAL'],
      });
      expect(status).toBe(201);
      const data = json.data as Record<string, unknown>;
      const columns = (data.mapping as { columns: { header: string; columnIndex: number }[] }).columns;
      // Price followed its NAME to its new position rather than staying at 1.
      expect(columns.find((c) => c.header === 'Precio')?.columnIndex).toBe(2);
      expect((data.drift as { drifted: boolean }).drifted).toBe(true);
    });

    it('refuses a shape whose names and types do not line up', async () => {
      const { status } = await call('POST', `/import/wizard/templates/${templateId}/apply`, {
        headers: ['Nombre', 'Precio'],
        types: ['TEXT'],
      });
      expect(status).toBe(400);
    });

    it('archives it', async () => {
      const { status } = await call('DELETE', `/import/wizard/templates/${templateId}`);
      expect(status).toBe(200);
    });
  });

  describe('a platform actor with no company chosen', () => {
    it('is refused everywhere, without being told anything about the data', async () => {
      const previous = { ...scope };
      scope.platform = true;
      scope.role = 'SUPER_ADMIN';
      scope.organizationId = null;

      for (const [method, path] of [
        ['GET', '/import/wizard/contract'],
        ['GET', '/import/wizard/templates'],
      ] as const) {
        const { status, json } = await call(method, path);
        expect(status).toBe(403);
        expect(String(json.message)).toMatch(/X-Managed-Organization/);
      }

      Object.assign(scope, previous);
    });
  });
});

if (!gate.enabled) {
  // eslint-disable-next-line no-console
  console.log(`wizard API PG suite skipped: ${gate.reason}`);
}
