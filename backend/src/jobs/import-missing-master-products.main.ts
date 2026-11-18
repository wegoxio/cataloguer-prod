import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module';
import { CatalogueRevalidationService } from '../common/catalogue-revalidation/catalogue-revalidation.service';

type SourceProduct = {
  catalogCode: string;
  sourceSystem: string;
  externalId: string;
  wordpressId: string;
  supplierProductCode?: string | null;
  name: string;
  description?: string | null;
  published: boolean;
  categories?: string[];
  price?: number | null;
  salePrice?: number | null;
  manualReview?: string[];
};

type Args = {
  mode: 'plan' | 'execute';
  confirm?: string;
  manifest: string;
  organization: string;
  store?: string;
  reportDir: string;
};

const EXPECTED_PRODUCTS = 63;
const CONFIRMATION = 'IMPORT_MISSING_MASTER_PRODUCTS';
const DEFAULT_MANIFEST = path.join(__dirname, 'data', 'designhof-missing-master-2026-11-18.json');

function parseArgs(argv: string[]): Args {
  const mode = argv[0] === 'execute' ? 'execute' : 'plan';
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    mode,
    confirm: value('--confirm'),
    manifest: path.resolve(value('--manifest') ?? DEFAULT_MANIFEST),
    organization: value('--organization') ?? 'DesignHof',
    store: value('--store'),
    reportDir: path.resolve(value('--report-dir') ?? path.join(process.cwd(), 'import-reports', 'missing-master')),
  };
}

function cleanText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/[ÃÂâ]/.test(text)) return text;
  const decoded = Buffer.from(text, 'latin1').toString('utf8');
  const markers = (candidate: string) => (candidate.match(/[ÃÂâ�]/g) ?? []).length;
  return markers(decoded) < markers(text) ? decoded : text;
}

function cleanCode(value: unknown): string | null {
  const text = cleanText(value);
  return !text || /^(-|n\/?a|null)$/i.test(text) ? null : text;
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'producto'
  );
}

function normalize(value: string): string {
  return slugify(value).replace(/-/g, '');
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) throw new Error('Cannot build an empty SQL IN clause');
  return values.map(() => '?').join(',');
}

async function rows<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T[]> {
  return em.getConnection().execute(sql, params) as Promise<T[]>;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'execute' && args.confirm !== CONFIRMATION) {
    throw new Error(`Execution requires --confirm ${CONFIRMATION}`);
  }

  const manifest = JSON.parse(await readFile(args.manifest, 'utf8')) as
    | { products?: SourceProduct[] }
    | SourceProduct[];
  const products = (Array.isArray(manifest) ? manifest : (manifest.products ?? [])).map((product) => ({
    ...product,
    catalogCode: cleanText(product.catalogCode),
    sourceSystem: cleanText(product.sourceSystem),
    externalId: cleanText(product.externalId),
    wordpressId: cleanText(product.wordpressId),
    supplierProductCode: cleanCode(product.supplierProductCode),
    name: cleanText(product.name),
    description: cleanText(product.description) || null,
    categories: (product.categories ?? []).map(cleanText).filter(Boolean),
  }));

  const unique = (values: string[]) => new Set(values).size === values.length;
  if (products.length !== EXPECTED_PRODUCTS)
    throw new Error(`Expected ${EXPECTED_PRODUCTS} products, received ${products.length}`);
  if (!unique(products.map((p) => p.externalId))) throw new Error('Manifest has duplicated external IDs');
  if (!unique(products.map((p) => p.catalogCode))) throw new Error('Manifest has duplicated catalogue codes');
  if (products.some((p) => !p.externalId || !p.catalogCode || !p.name || !p.sourceSystem))
    throw new Error('Manifest has incomplete identities');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const em = app.get(EntityManager).fork();
  const report: Record<string, unknown> = {
    status: 'STARTED',
    mode: args.mode,
    manifest: args.manifest,
    expected: EXPECTED_PRODUCTS,
    startedAt: new Date().toISOString(),
    errors: [],
  };
  let reportFile = '';

  try {
    const organizations = await rows<{ id: string; name: string; slug: string }>(
      em,
      `select id, name, slug from organizations where removed_at is null and archived_at is null and (lower(name)=lower(?) or lower(slug)=lower(?))`,
      [args.organization, args.organization],
    );
    if (organizations.length !== 1)
      throw new Error(`Organization '${args.organization}' resolved to ${organizations.length} records`);
    const organization = organizations[0];

    const stores = await rows<{ id: string; name: string; slug: string }>(
      em,
      `select id, name, slug from stores where organization_id=? and removed_at is null and archived_at is null ${args.store ? 'and (lower(name)=lower(?) or lower(slug)=lower(?))' : ''}`,
      args.store ? [organization.id, args.store, args.store] : [organization.id],
    );
    if (stores.length !== 1)
      throw new Error(
        `Store resolved to ${stores.length} records; use --store when the organization has more than one`,
      );
    const store = stores[0];

    const externalIds = products.map((product) => product.externalId);
    const catalogCodes = products.map((product) => product.catalogCode);
    const identities = await rows<{ external_id: string; target_id: string }>(
      em,
      `select external_id, target_id from import_external_identities where organization_id=? and source_system=? and target_type='product' and external_id in (${placeholders(externalIds)})`,
      [organization.id, products[0].sourceSystem, ...externalIds],
    );
    const identityMap = new Map(identities.map((entry) => [entry.external_id, entry.target_id]));
    const skuRows = await rows<{ id: string; sku: string }>(
      em,
      `select id, sku from products where organization_id=? and removed_at is null and sku in (${placeholders(catalogCodes)})`,
      [organization.id, ...catalogCodes],
    );
    const skuMap = new Map(skuRows.map((entry) => [entry.sku, entry.id]));

    const categoryRows = await rows<{ id: string; name: string; slug: string }>(
      em,
      `select id, name, slug from categories where organization_id=? and removed_at is null and archived_at is null`,
      [organization.id],
    );
    const categories = new Map<string, { id: string; name: string; slug: string }[]>();
    for (const category of categoryRows) {
      for (const key of new Set([normalize(category.name), normalize(category.slug)])) {
        categories.set(key, [...(categories.get(key) ?? []), category]);
      }
    }

    const create: SourceProduct[] = [];
    const existing: Array<{ externalId: string; productId: string }> = [];
    const collisions: Array<Record<string, unknown>> = [];
    const categoryWarnings: Array<Record<string, unknown>> = [];
    const categoryAssignments = new Map<string, string[]>();
    for (const product of products) {
      const identityTarget = identityMap.get(product.externalId);
      const skuTarget = skuMap.get(product.catalogCode);
      if (identityTarget) {
        if (skuTarget && skuTarget !== identityTarget)
          collisions.push({ externalId: product.externalId, sku: product.catalogCode, identityTarget, skuTarget });
        else existing.push({ externalId: product.externalId, productId: identityTarget });
        continue;
      }
      if (skuTarget) {
        collisions.push({
          externalId: product.externalId,
          sku: product.catalogCode,
          reason: 'SKU exists without matching external identity',
          skuTarget,
        });
        continue;
      }
      const ids: string[] = [];
      for (const sourceCategory of product.categories ?? []) {
        const matches = categories.get(normalize(sourceCategory)) ?? [];
        if (matches.length === 1) ids.push(matches[0].id);
        else
          categoryWarnings.push({
            externalId: product.externalId,
            category: sourceCategory,
            matches: matches.map((m) => ({ id: m.id, name: m.name })),
          });
      }
      categoryAssignments.set(product.externalId, [...new Set(ids)]);
      create.push(product);
    }

    Object.assign(report, {
      organization,
      store,
      counts: {
        manifest: products.length,
        create: create.length,
        existing: existing.length,
        collisions: collisions.length,
      },
      existing,
      collisions,
      categoryWarnings,
      manualReview: products
        .filter((p) => p.manualReview?.length)
        .map((p) => ({ externalId: p.externalId, sku: p.catalogCode, notes: p.manualReview })),
    });
    if (collisions.length) throw new Error(`Plan has ${collisions.length} identity/SKU collisions`);

    if (args.mode === 'execute') {
      const inserted: Array<{ externalId: string; sku: string; productId: string }> = [];
      await em.transactional(async (tx) => {
        const sql = tx.getConnection();
        await sql.execute(`select pg_advisory_xact_lock(hashtext(?))`, [`missing-master:${organization.id}`]);
        for (const product of create) {
          const productId = randomUUID();
          const price = Number(product.price ?? 0);
          const salePrice = product.salePrice == null ? null : Number(product.salePrice);
          const status = product.published ? 'PUBLISHED' : 'DRAFT';
          const slug = `${slugify(product.name)}-wp-${slugify(product.externalId)}`;
          await sql.execute(
            `insert into products (id,name,slug,description,sku,manufacturer_code,status,sale_mode,organization_id,price,sale_price,cost,stock_quantity,track_inventory,created_at,updated_at)
             values (?,?,?,?,?,?,?,?,?,?,?,?,0,false,now(),now())`,
            [
              productId,
              product.name,
              slug,
              product.description,
              product.catalogCode,
              product.supplierProductCode,
              status,
              price > 0 ? 'DIRECT' : 'ON_REQUEST',
              organization.id,
              price,
              salePrice,
              0,
            ],
          );
          await sql.execute(
            `insert into import_external_identities (organization_id,source_system,external_id,target_type,target_id,first_seen_at,last_seen_at)
             values (?,?,?,'product',?,now(),now())`,
            [organization.id, product.sourceSystem, product.externalId, productId],
          );
          for (const categoryId of categoryAssignments.get(product.externalId) ?? []) {
            await sql.execute(
              `insert into product_categories (product_id,category_id) values (?,?) on conflict do nothing`,
              [productId, categoryId],
            );
          }
          await sql.execute(
            `insert into store_products (id,organization_id,store_id,product_id,published,price,sale_price,cost,stock_quantity,track_inventory,created_at,updated_at)
             values (?,?,?,?,?,null,null,null,0,false,now(),now())`,
            [randomUUID(), organization.id, store.id, productId, product.published],
          );
          inserted.push({ externalId: product.externalId, sku: product.catalogCode, productId });
        }
        const verified = (await sql.execute(
          `select count(*)::int as count from import_external_identities where organization_id=? and source_system=? and target_type='product' and external_id in (${placeholders(externalIds)})`,
          [organization.id, products[0].sourceSystem, ...externalIds],
        )) as Array<{ count: number }>;
        if (verified[0]?.count !== products.length)
          throw new Error(`Identity verification returned ${verified[0]?.count}/${products.length}`);
      });
      report.inserted = inserted;
      report.status = 'EXECUTED';
      await app.get(CatalogueRevalidationService).request();
    } else {
      report.status = 'PLANNED';
    }
  } catch (error) {
    report.status = 'FAILED';
    (report.errors as unknown[]).push({
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(args.reportDir, { recursive: true });
    reportFile = path.join(args.reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.mode}.json`);
    await writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');
    await app.close();
  }

  console.log(`Estado: ${report.status}`);
  console.log(`Reporte: ${reportFile}`);
  console.log(
    JSON.stringify(
      {
        counts: report.counts,
        categoryWarnings: (report.categoryWarnings as unknown[] | undefined)?.length,
        manualReview: report.manualReview,
      },
      null,
      2,
    ),
  );
  if (report.status === 'FAILED') process.exitCode = 1;
}

void main();
