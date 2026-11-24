/* eslint-disable no-console */
import { Client } from 'pg';

type Mode = 'plan' | 'execute';
type Reference = { schema_name: string; table_name: string; column_name: string; delete_rule: string };

const mode = String(process.argv[2] ?? 'plan') as Mode;
const confirmation = String(process.argv[3] ?? '');
const targetSlug = 'asdasdasd';
const targetName = 'asdasdasd';

if (!['plan', 'execute'].includes(mode)) throw new Error('Mode must be plan or execute');
if (mode === 'execute' && confirmation !== 'PURGE_PRODUCT:asdasdasd') {
  throw new Error('Execution requires the exact confirmation PURGE_PRODUCT:asdasdasd');
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const matches = await client.query<{
      id: string; name: string; slug: string; sku: string | null; organization: string; status: string;
      parent_id: string | null; image_count: number; child_count: number;
    }>(
      `select p.id, p.name, p.slug, p.sku, o.name as organization, p.status, p.parent_id,
              (select count(*)::int from product_images i where i.product_id = p.id) as image_count,
              (select count(*)::int from products c where c.parent_id = p.id) as child_count
         from products p join organizations o on o.id = p.organization_id
        where lower(p.slug) = $1 and lower(p.name) = $2`,
      [targetSlug, targetName],
    );
    if (matches.rowCount === 0) {
      console.log(JSON.stringify({ mode, targetSlug, found: false, verdict: 'already absent' }));
      return;
    }
    if (matches.rowCount !== 1) throw new Error(`Expected exactly one test product, found ${matches.rowCount}`);
    const product = matches.rows[0];
    if (product.parent_id || product.child_count !== 0) throw new Error('Refusing to purge a product family member');
    if (product.image_count !== 0) throw new Error('Refusing to purge because image objects require separate storage cleanup');

    const references = await client.query<Reference>(
      `select ns.nspname as schema_name, rel.relname as table_name, att.attname as column_name,
              case c.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' else 'NO ACTION' end as delete_rule
         from pg_constraint c
         join pg_class rel on rel.oid = c.conrelid
         join pg_namespace ns on ns.oid = rel.relnamespace
         join unnest(c.conkey) with ordinality ck(attnum, ord) on true
         join pg_attribute att on att.attrelid = c.conrelid and att.attnum = ck.attnum
        where c.contype = 'f' and c.confrelid = 'products'::regclass and array_length(c.conkey, 1) = 1
        order by rel.relname`,
    );
    const counts: Record<string, number> = {};
    for (const reference of references.rows) {
      const key = `${reference.schema_name}.${reference.table_name}.${reference.column_name}`;
      const result = await client.query<{ count: number }>(
        `select count(*)::int as count from ${quote(reference.schema_name)}.${quote(reference.table_name)} where ${quote(reference.column_name)} = $1`,
        [product.id],
      );
      counts[key] = result.rows[0].count;
    }
    console.log(JSON.stringify({ mode, found: true, product, references: references.rows, counts }));
    if (mode === 'plan') return;

    await client.query('begin');
    try {
      // Explicitly clear every direct reference. This includes category/store
      // links and inventory rows for this one disposable product only.
      for (const reference of references.rows.filter((item) => item.table_name !== 'products')) {
        await client.query(
          `delete from ${quote(reference.schema_name)}.${quote(reference.table_name)} where ${quote(reference.column_name)} = $1`,
          [product.id],
        );
      }
      const deleted = await client.query(
        'delete from products where id = $1 and lower(slug) = $2 and lower(name) = $3 returning id',
        [product.id, targetSlug, targetName],
      );
      if (deleted.rowCount !== 1) throw new Error('The product changed during the purge; nothing was committed');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    const verification = await client.query('select count(*)::int as count from products where id = $1', [product.id]);
    console.log(JSON.stringify({ mode, purged: true, remaining: verification.rows[0].count }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
