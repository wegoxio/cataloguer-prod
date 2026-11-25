/* eslint-disable no-console */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module';
import { InventoryStockService } from '../modules/inventory/ledger/inventory-stock.service';
import { CatalogueRevalidationService } from '../common/catalogue-revalidation/catalogue-revalidation.service';

const ORGANIZATION = 'DesignHof';
const CATEGORY = 'EXTERIORES';
const TARGET_STOCK = 2;
const CONFIRMATION = 'PUBLISH_EXTERIORES_STOCK_2';

type Candidate = {
  id: string;
  name: string;
  slug: string;
  status: string;
  current_stock: number;
  pivot_exists: boolean;
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
      `select id from organizations where lower(name) = lower(?) and deleted_at is null`,
      [ORGANIZATION],
    );
    if (organizations.length !== 1) throw new Error(`Expected one active ${ORGANIZATION} organization, found ${organizations.length}`);
    const organizationId = organizations[0].id;

    const categories: { id: string; name: string; slug: string }[] = await em.execute(
      `select id, name, slug from categories
        where organization_id = ?::uuid and archived_at is null and lower(name) = lower(?)`,
      [organizationId, CATEGORY],
    );
    if (categories.length !== 1) throw new Error(`Expected one active ${CATEGORY} category, found ${categories.length}`);

    const stores: { id: string; name: string; slug: string }[] = await em.execute(
      `select id, name, slug from stores where organization_id = ?::uuid and archived_at is null`,
      [organizationId],
    );
    if (stores.length !== 1) throw new Error(`Expected one active DesignHof store, found ${stores.length}`);
    const store = stores[0];
    const locationId = await stock.storeLocationId(em, organizationId, store.id);

    const candidates: Candidate[] = await em.execute(
      `with recursive category_tree as (
         select id from categories where id = ?::uuid
         union all
         select c.id from categories c join category_tree t on c.parent_id = t.id where c.archived_at is null
       ), selected as (
         select distinct p.id
           from products p
           join product_categories pc on pc.product_id = p.id
          where pc.category_id in (select id from category_tree)
            and p.organization_id = ?::uuid and p.archived_at is null and p.removed_at is null
            and not exists (select 1 from products child where child.parent_id = p.id and child.removed_at is null)
       )
       select p.id, p.name, p.slug, p.status,
              coalesce((select sum(b.quantity)::int from inventory_balances b
                         where b.organization_id = p.organization_id and b.product_id = p.id
                           and b.location_id = ?::uuid and b.operational_state = 'AVAILABLE'), 0)::int as current_stock,
              (sp.id is not null) as pivot_exists, coalesce(sp.published, false) as pivot_published
         from selected s join products p on p.id = s.id
         left join store_products sp on sp.product_id = p.id and sp.store_id = ?::uuid
        order by p.name, p.id`,
      [categories[0].id, organizationId, locationId, store.id],
    );
    if (candidates.length === 0) throw new Error(`${CATEGORY} contains no active sellable products`);

    console.log(JSON.stringify({
      mode,
      organization: ORGANIZATION,
      category: categories[0],
      store,
      targetStock: TARGET_STOCK,
      total: candidates.length,
      summary: {
        draft: candidates.filter((p) => p.status !== 'PUBLISHED').length,
        unpublishedForStore: candidates.filter((p) => !p.pivot_published).length,
        stockNotTwo: candidates.filter((p) => p.current_stock !== TARGET_STOCK).length,
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
          origin: 'production-exteriores-bulk-2026-11-25',
        });
      }
    });

    const verification: { total: number; ready: number; wrong: number }[] = await em.execute(
      `with ids as (select unnest(?::uuid[]) id)
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
      [candidates.map((p) => p.id), locationId, TARGET_STOCK, locationId, TARGET_STOCK, store.id],
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
