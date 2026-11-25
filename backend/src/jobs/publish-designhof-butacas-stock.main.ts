/* eslint-disable no-console */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module';
import { CatalogueRevalidationService } from '../common/catalogue-revalidation/catalogue-revalidation.service';
import { InventoryStockService } from '../modules/inventory/ledger/inventory-stock.service';

const ORGANIZATION = 'DesignHof';
const TARGET_STOCK = 1;
const CONFIRMATION = 'PUBLISH_DESIGNHOF_BUTACAS_STOCK_1';

type Category = { id: string; name: string; slug: string; parent_name: string | null };
type Candidate = {
  id: string;
  name: string;
  slug: string;
  status: string;
  role: string;
  categories: string;
  current_stock: number;
  pivot_published: boolean;
};

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'plan';
  if (!['plan', 'execute'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  if (mode === 'execute' && process.argv[3] !== CONFIRMATION) throw new Error('Exact confirmation is required');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const orm = app.get(MikroORM);
    const stock = app.get(InventoryStockService);
    const revalidation = app.get(CatalogueRevalidationService);
    const em = orm.em.fork() as EntityManager;

    const organizations: { id: string }[] = await em.execute(
      `select id from organizations where lower(name) = lower(?) and archived_at is null and removed_at is null`,
      [ORGANIZATION],
    );
    if (organizations.length !== 1) throw new Error(`Expected one active ${ORGANIZATION} organization, found ${organizations.length}`);
    const organizationId = organizations[0].id;

    const categories: Category[] = await em.execute(
      `select c.id, c.name, c.slug, parent.name as parent_name
         from categories c
         left join categories parent on parent.id = c.parent_category_id
        where c.organization_id = ?::uuid and c.archived_at is null and c.removed_at is null
          and (c.slug like 'mobiliario-butacas%' or c.slug like 'mobiliario-h1-%butacas%')
        order by c.slug`,
      [organizationId],
    );
    if (categories.length !== 4) throw new Error(`Expected exactly four active Butacas categories, found ${categories.length}`);

    const stores: { id: string; name: string; slug: string }[] = await em.execute(
      `select id, name, slug from stores where organization_id = ?::uuid and archived_at is null`,
      [organizationId],
    );
    if (stores.length !== 1) throw new Error(`Expected one active DesignHof store, found ${stores.length}`);
    const store = stores[0];
    const locationId = await stock.storeLocationId(em, organizationId, store.id);
    const categoryIds = categories.map((category) => category.id);
    const placeholders = categoryIds.map(() => '?::uuid').join(', ');

    const candidates: Candidate[] = await em.execute(
      `with selected as (
         select distinct p.id
           from products p
           join product_categories pc on pc.product_id = p.id
          where pc.category_id in (${placeholders})
            and p.organization_id = ?::uuid and p.archived_at is null and p.removed_at is null
            and not exists (select 1 from products child where child.parent_id = p.id and child.removed_at is null)
       )
       select p.id, p.name, p.slug, p.status,
              case when p.parent_id is not null then 'CHILD' else 'STANDALONE' end role,
              coalesce((select string_agg(distinct c.name, ' | ' order by c.name)
                          from product_categories pc join categories c on c.id = pc.category_id
                         where pc.product_id = p.id and pc.category_id in (${placeholders})), '') categories,
              coalesce((select sum(b.quantity)::int from inventory_balances b
                         where b.organization_id = p.organization_id and b.product_id = p.id
                           and b.location_id = ?::uuid and b.operational_state = 'AVAILABLE'), 0)::int current_stock,
              coalesce(sp.published, false) pivot_published
         from selected s join products p on p.id = s.id
         left join store_products sp on sp.product_id = p.id and sp.store_id = ?::uuid
        order by p.name, p.id`,
      [...categoryIds, organizationId, ...categoryIds, locationId, store.id],
    );
    if (candidates.length === 0) throw new Error('The Butacas categories contain no active sellable products');

    console.log(JSON.stringify({
      mode,
      organization: ORGANIZATION,
      categories,
      store,
      targetStock: TARGET_STOCK,
      total: candidates.length,
      summary: {
        standalone: candidates.filter((product) => product.role === 'STANDALONE').length,
        children: candidates.filter((product) => product.role === 'CHILD').length,
        draft: candidates.filter((product) => product.status !== 'PUBLISHED').length,
        unpublishedForStore: candidates.filter((product) => !product.pivot_published).length,
        stockNotOne: candidates.filter((product) => product.current_stock !== TARGET_STOCK).length,
      },
      products: candidates,
    }));

    if (mode === 'plan') return;

    await em.transactional(async (tem) => {
      for (const product of candidates) {
        await tem.execute(
          `update products set status = 'PUBLISHED', track_inventory = true, updated_at = now()
            where id = ?::uuid and organization_id = ?::uuid and archived_at is null and removed_at is null`,
          [product.id, organizationId],
        );
        await tem.execute(
          `insert into store_products
             (id, organization_id, store_id, product_id, published, stock_quantity, track_inventory, created_at, updated_at)
           values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, 0, true, now(), now())
           on conflict (store_id, product_id) do update
             set published = true, track_inventory = true, organization_id = excluded.organization_id, updated_at = now()`,
          [organizationId, store.id, product.id],
        );
        await stock.setBranchQuantity(tem as EntityManager, {
          organizationId,
          storeId: store.id,
          productId: product.id,
          targetQuantity: TARGET_STOCK,
          origin: 'production-designhof-butacas-bulk-2026-11-25',
        });
      }
    });

    const ids = candidates.map((product) => product.id);
    const idPlaceholders = ids.map(() => '?::uuid').join(', ');
    const verification: { total: number; ready: number; wrong: number }[] = await em.execute(
      `with ids as (select id from products where id in (${idPlaceholders}))
       select count(*)::int total,
              count(*) filter (where p.status = 'PUBLISHED' and sp.published = true and sp.track_inventory = true
                and coalesce((select sum(b.quantity) from inventory_balances b
                               where b.organization_id = p.organization_id and b.product_id = p.id
                                 and b.location_id = ?::uuid and b.operational_state = 'AVAILABLE'), 0) = ?)::int ready,
              count(*) filter (where not (p.status = 'PUBLISHED' and sp.published = true and sp.track_inventory = true
                and coalesce((select sum(b.quantity) from inventory_balances b
                               where b.organization_id = p.organization_id and b.product_id = p.id
                                 and b.location_id = ?::uuid and b.operational_state = 'AVAILABLE'), 0) = ?))::int wrong
         from ids join products p on p.id = ids.id
         join store_products sp on sp.product_id = p.id and sp.store_id = ?::uuid`,
      [...ids, locationId, TARGET_STOCK, locationId, TARGET_STOCK, store.id],
    );
    if (verification[0].wrong !== 0 || verification[0].ready !== candidates.length) {
      throw new Error(`Verification failed: ${JSON.stringify(verification[0])}`);
    }
    revalidation.request();
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    console.log(JSON.stringify({ mode: 'execute', updated: candidates.length, verification: verification[0] }));
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
