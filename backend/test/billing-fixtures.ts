/**
 * Fixtures for the billing PostgreSQL suites. The reapply path records who
 * acted (a user id kept as a fact, deliberately without a foreign key), so a
 * real user is inserted with the table's REQUIRED columns discovered at run
 * time rather than assumed — a column added later keeps these suites honest
 * instead of silently breaking them.
 */
interface Sql {
  execute: (sql: string, params?: unknown[]) => Promise<any>;
}

export async function insertMinimalUser(em: Sql): Promise<string> {
  const existing: { id: string }[] = await em.execute(`select id from users order by created_at limit 1`);
  if (existing[0]) return existing[0].id;
  const cols: { column_name: string; data_type: string }[] = await em.execute(
    `select column_name, data_type from information_schema.columns
      where table_name = 'users' and is_nullable = 'NO' and column_default is null and column_name <> 'id'
      order by ordinal_position`,
  );
  const names = cols.map((c) => `"${c.column_name}"`).join(', ');
  const values: string[] = [];
  for (const c of cols) {
    if (c.column_name === 'email') values.push(`'billing-fixture-${Date.now()}@example.test'`);
    else if (c.column_name === 'role_id') values.push(`(${await roleIdSql(em)})`);
    else if (c.data_type === 'uuid') values.push('gen_random_uuid()');
    else if (c.data_type.startsWith('timestamp')) values.push('now()');
    else if (c.data_type === 'boolean') values.push('false');
    else if (c.data_type === 'integer' || c.data_type === 'numeric') values.push('0');
    else if (c.data_type === 'jsonb' || c.data_type === 'json') values.push(`'{}'`);
    else values.push(`'x'`);
  }
  const rows: { id: string }[] = await em.execute(
    `insert into users (${names}) values (${values.join(', ')}) returning id`,
  );
  return rows[0].id;
}

async function roleIdSql(em: Sql): Promise<string> {
  const roles: { id: string }[] = await em.execute(`select id from roles limit 1`);
  if (roles[0]) return `'${roles[0].id}'::uuid`;
  const cols: { column_name: string; data_type: string }[] = await em.execute(
    `select column_name, data_type from information_schema.columns
      where table_name = 'roles' and is_nullable = 'NO' and column_default is null and column_name <> 'id'`,
  );
  const names = cols.map((c) => `"${c.column_name}"`).join(', ');
  const values = cols
    .map((c) =>
      c.data_type.startsWith('timestamp') ? 'now()' : c.data_type === 'uuid' ? 'gen_random_uuid()' : `'VIEWER'`,
    )
    .join(', ');
  const rows: { id: string }[] = await em.execute(`insert into roles (${names}) values (${values}) returning id`);
  return `'${rows[0].id}'::uuid`;
}
