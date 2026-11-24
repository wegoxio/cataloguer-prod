/* eslint-disable no-console */
import { Client } from 'pg';

type Mode = 'plan' | 'execute';

const email = 'coclemmert@gmail.com';
const mode = String(process.argv[2] ?? 'plan') as Mode;
const confirmation = String(process.argv[3] ?? '');

if (!['plan', 'execute'].includes(mode)) throw new Error('Mode must be plan or execute');
if (mode === 'execute' && confirmation !== `PURGE_USER:${email}`) {
  throw new Error(`Execution requires the exact confirmation PURGE_USER:${email}`);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const users = await client.query<{
      id: string;
      email: string;
      role: string;
      organization: string | null;
      store: string | null;
      deleted_at: Date | null;
    }>(
      `select u.id, u.email, r.name as role, o.name as organization, s.name as store, u.deleted_at
         from users u
         join roles r on r.id = u.role_id
         left join organizations o on o.id = u.organization_id
         left join stores s on s.id = u.store_id
        where lower(u.email) = $1`,
      [email],
    );

    if (users.rowCount === 0) {
      console.log(JSON.stringify({ mode, email, found: false, verdict: 'already absent' }));
      return;
    }
    if (users.rowCount !== 1) throw new Error(`Expected one account for ${email}, found ${users.rowCount}`);
    const user = users.rows[0];

    const dependencies = await client.query<{ table_name: string; delete_rule: string }>(
      `select tc.table_name, rc.delete_rule
         from information_schema.referential_constraints rc
         join information_schema.table_constraints tc
           on tc.constraint_name = rc.constraint_name and tc.constraint_schema = rc.constraint_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = rc.unique_constraint_name and ccu.constraint_schema = rc.unique_constraint_schema
        where ccu.table_name = 'users'
        order by tc.table_name`,
    );
    const counts = await client.query<{ refresh_tokens: string; password_reset_tokens: string; plan_challenges: string }>(
      `select
         (select count(*) from refresh_tokens where user_id = $1) as refresh_tokens,
         (select count(*) from password_reset_tokens where user_id = $1) as password_reset_tokens,
         (select count(*) from organization_plan_change_challenges where actor_user_id = $1) as plan_challenges`,
      [user.id],
    );

    console.log(JSON.stringify({ mode, email, found: true, user, dependencies: dependencies.rows, counts: counts.rows[0] }));
    if (mode === 'plan') return;

    await client.query('begin');
    try {
      await client.query('delete from refresh_tokens where user_id = $1', [user.id]);
      await client.query('delete from password_reset_tokens where user_id = $1', [user.id]);
      await client.query('delete from organization_plan_change_challenges where actor_user_id = $1', [user.id]);
      const deleted = await client.query('delete from users where id = $1 and lower(email) = $2 returning id', [user.id, email]);
      if (deleted.rowCount !== 1) throw new Error('The account changed during the purge; nothing was committed');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    const verification = await client.query('select count(*)::int as count from users where lower(email) = $1', [email]);
    console.log(JSON.stringify({ mode, email, purged: true, remaining: verification.rows[0].count }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
