import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { OrganizationOnboardingService, OnboardRequest } from '../../onboarding/organization-onboarding.service';
import { UsersService } from '../../../users/users.service';
import { User } from '../../../users/entities/user.entity';
import { Role } from '../../../users/entities/role.entity';
import { Organization } from '../../entities/organization.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * TWO COLLISION CLASSES, AND THE EMAIL LOCK ONLY COVERS ONE.
 *
 * Two requests naming the same prospective manager meet on
 * `onboard-email:<email>`. Two requests naming the same COMPANY with DIFFERENT
 * people never touch that lock at all — they collide on `organizations.slug`,
 * which is allocated read-then-insert. Without the second lock one of them dies
 * on a unique index, reporting a constraint rather than anything about
 * onboarding, and possibly after other rows were already written.
 *
 * Every test here runs its attempts on SEPARATE connections, because Nest gives
 * each request its own EntityManager fork and a shared one would serialise
 * inside MikroORM rather than inside PostgreSQL — proving nothing.
 */
d('onboarding under concurrency (real PostgreSQL, #276)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  const conn = () => em.getConnection();
  const one = async (sql: string, params: unknown[] = []) => (await conn().execute(sql, params))[0];
  const all = (sql: string, params: unknown[] = []) => conn().execute(sql, params);

  let seq = 0;
  const roleId = async (name: string) => (await one('select id from roles where name = ?', [name])).id as string;

  /** One service per connection — what makes the race real. */
  const serviceOnOwnConnection = (): OrganizationOnboardingService => {
    const fork = pg.orm.em.fork() as EntityManager;
    const mail = {
      send: async () => true,
      renderTemplate: (_t: string, _s: string, vars: Record<string, string>) => `<a href="${vars.link}">go</a>`,
    };
    const users = new UsersService(
      fork.getRepository(User) as never,
      fork.getRepository(Role) as never,
      fork.getRepository(PasswordResetToken) as never,
      new AuditLogService(fork.getRepository(AuditLog) as never) as never,
      mail as never,
      { get: () => 'https://panel.example.com' } as never,
    );
    return new OrganizationOnboardingService(
      fork.getRepository(Organization) as never,
      users as never,
      new AuditLogService(fork.getRepository(AuditLog) as never) as never,
    );
  };

  const actor = async (): Promise<User> => {
    seq += 1;
    const row = await one(
      `insert into users (email, password_hash, role_id, created_at, updated_at)
       values (?, 'x', ?, now(), now()) returning id`,
      [`race-actor-${seq}@wegox.com`, await roleId('SUPER_ADMIN')],
    );
    return (await em.fork().findOne(User, { id: row.id }, { populate: ['role'] as never })) as User;
  };

  const request = (over: Partial<OnboardRequest> = {}): OnboardRequest => {
    seq += 1;
    return {
      organization: { name: `Race ${seq}`, plan: 'BASICO' },
      store: { name: `Race Store ${seq}`, websiteUrl: `https://race${seq}.example.com` },
      manager: { email: `race${seq}@example.com`, firstName: 'Ana', lastName: 'Díaz' },
      ...over,
    };
  };

  const organizationsNamed = async (name: string): Promise<number> =>
    Number((await one(`select count(*)::int as c from organizations where name = ?`, [name])).c);
  const usersWith = async (email: string): Promise<number> =>
    Number((await one(`select count(*)::int as c from users where email = ?`, [email])).c);
  const tokensFor = async (email: string): Promise<number> =>
    Number(
      (
        await one(
          `select count(*)::int as c from password_reset_tokens t join users u on u.id = t.user_id where u.email = ?`,
          [email],
        )
      ).c,
    );

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    for (const name of ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await conn().execute(
        `insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)`,
        [name, name],
      );
    }
  });

  afterAll(async () => {
    await pg?.close();
  });

  it('SAME EMAIL, SAME REQUEST: one organization, one user, one token', async () => {
    const a = await actor();
    const req = request();
    const results = await Promise.allSettled([
      serviceOnOwnConnection().onboard(a, req),
      serviceOnOwnConnection().onboard(a, req),
    ]);

    // Both may succeed — one creates, the other recognises the retry.
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<never>[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await organizationsNamed(req.organization.name)).toBe(1);
    expect(await usersWith(req.manager.email)).toBe(1);
    expect(await tokensFor(req.manager.email)).toBe(1);
  });

  it('SAME EMAIL, CONFLICTING REQUEST: exactly one commits, the other writes nothing', async () => {
    const a = await actor();
    const first = request();
    const second = { ...first, organization: { ...first.organization, name: `${first.organization.name} Different` } };

    const results = await Promise.allSettled([
      serviceOnOwnConnection().onboard(a, first),
      serviceOnOwnConnection().onboard(a, second),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/already belongs to a user/i);
    expect(await usersWith(first.manager.email)).toBe(1);
    // Exactly one of the two company names exists, never both.
    const both =
      (await organizationsNamed(first.organization.name)) + (await organizationsNamed(second.organization.name));
    expect(both).toBe(1);
  });

  it('SAME ORGANIZATION NAME, DIFFERENT EMAILS: two valid unique slugs, no constraint error', async () => {
    const a = await actor();
    const name = `Slug Race ${Date.now().toString(36)}`;
    const one_ = request({ organization: { name, plan: 'BASICO' } });
    const two_ = request({ organization: { name, plan: 'BASICO' } });

    const results = await Promise.allSettled([
      serviceOnOwnConnection().onboard(a, one_),
      serviceOnOwnConnection().onboard(a, two_),
    ]);

    // BOTH are legitimate new clients that happen to share a display name.
    // Neither may fail, and neither may fail with a unique-index message.
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`expected both to succeed, got: ${String((r as PromiseRejectedResult).reason?.message)}`);
      }
    }
    expect(await organizationsNamed(name)).toBe(2);
    const slugs = (await all(`select slug from organizations where name = ? order by slug`, [name])).map(
      (r: any) => r.slug,
    );
    expect(new Set(slugs).size).toBe(2);
  });

  it('CONCURRENT EXACT RETRIES of an already-completed onboarding stay a no-op', async () => {
    const a = await actor();
    const req = request();
    await serviceOnOwnConnection().onboard(a, req);
    const before = {
      orgs: await organizationsNamed(req.organization.name),
      users: await usersWith(req.manager.email),
      tokens: await tokensFor(req.manager.email),
      audits: Number((await one(`select count(*)::int as c from audit_logs`)).c),
    };

    const results = await Promise.allSettled([
      serviceOnOwnConnection().onboard(a, req),
      serviceOnOwnConnection().onboard(a, req),
      serviceOnOwnConnection().onboard(a, req),
    ]);
    for (const r of results) expect(r.status).toBe('fulfilled');
    for (const r of results) expect((r as PromiseFulfilledResult<never>).value['idempotent' as never]).toBe(true);

    expect(await organizationsNamed(req.organization.name)).toBe(before.orgs);
    expect(await usersWith(req.manager.email)).toBe(before.users);
    // No second token, and no duplicate creation audits.
    expect(await tokensFor(req.manager.email)).toBe(before.tokens);
    expect(Number((await one(`select count(*)::int as c from audit_logs`)).c)).toBe(before.audits);
  });

  it('a second onboarding BLOCKS while the email lock is held elsewhere', async () => {
    const a = await actor();
    const req = request();
    const holder = pg.orm.em.fork() as EntityManager;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = holder.transactional(async (tem) => {
      await tem.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [
        `onboard-email:${req.manager.email.toLowerCase()}`,
      ]);
      await held;
    });
    await new Promise((r) => setTimeout(r, 150));

    const marker = Symbol('timeout');
    const raced = await Promise.race([
      serviceOnOwnConnection()
        .onboard(a, req)
        .then(() => 'completed' as const)
        .catch(() => 'rejected' as const),
      new Promise((r) => setTimeout(() => r(marker), 1_500)),
    ]);
    release();
    await finished;
    // If it completed while the lock was held, it never asked for the lock.
    expect(raced).toBe(marker);
  });
  /**
   * THE COLLISION THE ORGANIZATION LOCK DOES NOT COVER (#276 correction 2).
   *
   * `stores.slug` is its own GLOBAL unique namespace. Two requests with
   * different company names and different manager emails take different email
   * locks and different organization-slug locks — they meet nowhere — and then
   * both allocate the same store slug read-then-insert. Without a store-slug
   * lock one of them dies on `stores_slug_unique` after its organization row
   * was already written.
   */
  it('SAME STORE NAME, different companies and emails: both commit with distinct store slugs', async () => {
    const a = await actor();
    const storeName = `Shared Site ${Date.now().toString(36)}`;
    const first = request({ store: { name: storeName, websiteUrl: 'https://one.example.com' } });
    const second = request({ store: { name: storeName, websiteUrl: 'https://two.example.com' } });
    // Nothing else is shared: different companies, different people.
    expect(first.organization.name).not.toBe(second.organization.name);
    expect(first.manager.email).not.toBe(second.manager.email);

    const results = await Promise.allSettled([
      serviceOnOwnConnection().onboard(a, first),
      serviceOnOwnConnection().onboard(a, second),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`expected both to succeed, got: ${String((r as PromiseRejectedResult).reason?.message)}`);
      }
    }

    const rows = await all(`select slug from stores where name = ? order by slug`, [storeName]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.slug)).size).toBe(2);
    // Both companies are whole: each has its organization AND its manager.
    expect(await organizationsNamed(first.organization.name)).toBe(1);
    expect(await organizationsNamed(second.organization.name)).toBe(1);
    expect(await usersWith(first.manager.email)).toBe(1);
    expect(await usersWith(second.manager.email)).toBe(1);
  });

  /**
   * The keys are `onboard-org-slug:<base>` and `onboard-store-slug:<base>`, in
   * separate namespaces, so a company whose first website carries its own name
   * takes TWO different locks rather than one key twice. Two such requests take
   * them in the same order and simply queue; an aliased key would have them
   * self-block or, worse, look interchangeable to the next reader.
   */
  it('a store named after its company takes two locks and cannot deadlock', async () => {
    const a = await actor();
    const name = `Twin ${Date.now().toString(36)}`;
    const first = request({ organization: { name, plan: 'BASICO' }, store: { name } });
    const second = request({ organization: { name, plan: 'BASICO' }, store: { name } });

    const finished = await Promise.race([
      Promise.allSettled([serviceOnOwnConnection().onboard(a, first), serviceOnOwnConnection().onboard(a, second)]),
      new Promise((r) => setTimeout(() => r('TIMED OUT — deadlock'), 20_000)),
    ]);
    expect(finished).not.toBe('TIMED OUT — deadlock');
    for (const r of finished as PromiseSettledResult<unknown>[]) {
      if (r.status === 'rejected') {
        throw new Error(`expected both to succeed, got: ${String((r as PromiseRejectedResult).reason?.message)}`);
      }
    }
    expect(await organizationsNamed(name)).toBe(2);
    const slugs = (await all(`select slug from stores where name = ? order by slug`, [name])).map((r: any) => r.slug);
    expect(slugs).toHaveLength(2);
    expect(new Set(slugs).size).toBe(2);
  });

  it('an onboarding BLOCKS while the STORE-slug lock is held elsewhere', async () => {
    const a = await actor();
    const storeName = `Held Site ${Date.now().toString(36)}`;
    const req = request({ store: { name: storeName } });
    const base = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const holder = pg.orm.em.fork() as EntityManager;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = holder.transactional(async (tem) => {
      await tem.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`onboard-store-slug:${base}`]);
      await held;
    });
    await new Promise((r) => setTimeout(r, 150));

    const marker = Symbol('timeout');
    const raced = await Promise.race([
      serviceOnOwnConnection()
        .onboard(a, req)
        .then(() => 'completed' as const)
        .catch(() => 'rejected' as const),
      new Promise((r) => setTimeout(() => r(marker), 1_500)),
    ]);
    release();
    await finished;
    // Completing while the lock was held would mean it was never asked for.
    expect(raced).toBe(marker);
  });
});
