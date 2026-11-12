/* eslint-disable no-console */
import 'reflect-metadata';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import readXlsxFile from 'read-excel-file/node';
import { AppModule } from '../app.module';
import { CatalogueRevalidationService } from '../common/catalogue-revalidation/catalogue-revalidation.service';

type Mode = 'plan' | 'execute';
type PriceRow = { excelRow: number; code: string; price: string };
type ProductMatch = {
  id: string;
  name: string;
  manufacturer_code: string;
  price: string;
  parent_id: string | null;
  status: string;
  archived_at: Date | string | null;
};

const CONFIRMATION = 'UPDATE_H1_PRICES';
const asText = (value: unknown) => String(value ?? '').trim();

function parseArgs(argv: string[]) {
  const mode = (argv[0] ?? 'plan') as Mode;
  if (!['plan', 'execute'].includes(mode)) throw new Error(`Modo desconocido: ${mode}`);
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Argumento inesperado: ${token}`);
    const key = token.slice(2);
    flags[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return {
    mode,
    workbook: path.resolve(String(flags.workbook ?? 'PRECIOS NUEVOS H1.xlsx')),
    manifest: flags.manifest ? path.resolve(String(flags.manifest)) : undefined,
    organization: String(flags.organization ?? 'DesignHof'),
    confirmation: String(flags.confirm ?? ''),
    syncStoreOverrides: flags['sync-store-overrides'] === true,
    allowMissingProducts: flags['allow-missing-products'] === true,
    reportDir: path.resolve(
      String(
        flags['report-dir'] ??
          process.env.H1_PRICE_REPORT_DIR ??
          (process.env.NODE_ENV === 'production'
            ? '/tmp/cataloguer-h1-price-reports'
            : path.join('reports', 'h1-price-updates')),
      ),
    ),
  };
}

function validateRows(rows: PriceRow[], source: string): PriceRow[] {
  if (!rows.length) throw new Error(`${source} no contiene productos`);
  const duplicates = rows.filter((row, index) => rows.findIndex((candidate) => candidate.code === row.code) !== index);
  if (duplicates.length)
    throw new Error(`Códigos duplicados en ${source}: ${[...new Set(duplicates.map((row) => row.code))].join(', ')}`);
  return rows;
}

function money(value: unknown, excelRow: number): string {
  const numeric = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0)
    throw new Error(`Fila ${excelRow}: precio inválido '${asText(value)}'`);
  const rounded = Math.round((numeric + Number.EPSILON) * 100) / 100;
  if (Math.abs(numeric - rounded) > 0.000001) throw new Error(`Fila ${excelRow}: el precio tiene más de dos decimales`);
  return rounded.toFixed(2);
}

async function readWorkbook(workbook: string): Promise<{ sheet: string; rows: PriceRow[] }> {
  const sheets = (await readXlsxFile(workbook)) as unknown as Array<{
    sheet: string;
    data: unknown[][];
  }>;
  const selected = sheets.find((sheet) => sheet.sheet.toLowerCase() === 'hoja1') ?? sheets[0];
  if (!selected?.data?.length) throw new Error('El Excel no contiene datos');

  const rows = selected.data
    .map((cells, index) => ({ cells, excelRow: index + 1 }))
    .filter(({ cells }) => cells.some((cell) => cell !== null && asText(cell) !== ''))
    .map(({ cells, excelRow }) => {
      const code = asText(cells[0]).toUpperCase();
      if (!/^H\d+$/.test(code)) throw new Error(`Fila ${excelRow}: código H1 inválido '${asText(cells[0])}'`);
      return { excelRow, code, price: money(cells[1], excelRow) };
    });

  return { sheet: selected.sheet, rows: validateRows(rows, 'el Excel') };
}

async function readManifest(manifest: string): Promise<{ sheet: string; rows: PriceRow[] }> {
  const parsed = JSON.parse(await fs.readFile(manifest, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('El manifiesto debe ser un arreglo JSON');
  const rows = parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`Registro ${index + 1}: formato inválido`);
    const record = item as Record<string, unknown>;
    const code = asText(record.code).toUpperCase();
    if (!/^H\d+$/.test(code)) throw new Error(`Registro ${index + 1}: código H1 inválido '${asText(record.code)}'`);
    return { excelRow: index + 1, code, price: money(record.price, index + 1) };
  });
  return { sheet: 'manifest', rows: validateRows(rows, 'el manifiesto') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  await fs.mkdir(options.reportDir, { recursive: true });
  const reportPath = path.join(
    options.reportDir,
    `${startedAt.toISOString().replace(/[:.]/g, '-')}-${options.mode}.json`,
  );
  const workbook = options.manifest ? await readManifest(options.manifest) : await readWorkbook(options.workbook);
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  const report: Record<string, unknown> = {
    status: 'PLANNING',
    mode: options.mode,
    startedAt: startedAt.toISOString(),
    source: options.manifest ?? options.workbook,
    sheet: workbook.sheet,
    organization: options.organization,
    inputRows: workbook.rows.length,
  };

  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const orm = app.get(MikroORM);
    const db = orm.em.fork().getConnection();
    const [databaseIdentity] = await db.execute<{ database: string; user_name: string }[]>(
      'select current_database() as database, current_user as user_name',
    );
    report.database = databaseIdentity;

    const organizations = await db.execute<Array<{ id: string; name: string }>>(
      `select id, name from organizations
       where lower(name) = lower(?) and archived_at is null and removed_at is null`,
      [options.organization],
    );
    if (organizations.length !== 1)
      throw new Error(
        `Se esperaba una organización activa '${options.organization}' y se encontraron ${organizations.length}`,
      );
    const organization = organizations[0];
    report.organization = organization;

    const codes = workbook.rows.map((row) => row.code);
    const matches = await db.execute<ProductMatch[]>(
      `select id, name, manufacturer_code, price, parent_id, status, archived_at
       from products
       where organization_id = ?::uuid
         and removed_at is null
         and upper(trim(manufacturer_code)) in (?)
       order by upper(trim(manufacturer_code)), id`,
      [organization.id, codes],
    );
    const byCode = new Map<string, ProductMatch[]>();
    for (const match of matches) {
      const code = match.manufacturer_code.trim().toUpperCase();
      byCode.set(code, [...(byCode.get(code) ?? []), match]);
    }

    const missing = workbook.rows
      .filter((row) => !byCode.has(row.code))
      .map((row) => ({ excelRow: row.excelRow, code: row.code }));
    const ambiguous = workbook.rows
      .filter((row) => (byCode.get(row.code)?.length ?? 0) > 1)
      .map((row) => ({ excelRow: row.excelRow, code: row.code, matches: byCode.get(row.code) }));
    const resolved = workbook.rows
      .filter((row) => byCode.get(row.code)?.length === 1)
      .map((row) => {
        const product = byCode.get(row.code)![0];
        return {
          excelRow: row.excelRow,
          code: row.code,
          productId: product.id,
          productName: product.name,
          status: product.status,
          archived: product.archived_at !== null,
          parentId: product.parent_id,
          oldPrice: Number(product.price).toFixed(2),
          newPrice: row.price,
          changed: Number(product.price).toFixed(2) !== row.price,
        };
      });

    const productIds = resolved.map((row) => row.productId);
    const parentIds = [...new Set(resolved.map((row) => row.parentId).filter((id): id is string => Boolean(id)))];
    const affectedProductIds = [...new Set([...productIds, ...parentIds])];
    const overrides = affectedProductIds.length
      ? await db.execute<Array<{ product_id: string; store_id: string; store_name: string; price: string }>>(
          `select sp.product_id, sp.store_id, s.name as store_name, sp.price
           from store_products sp
           join stores s on s.id = sp.store_id
           where sp.organization_id = ?::uuid and sp.product_id in (?) and sp.price is not null
           order by sp.product_id, s.name`,
          [organization.id, affectedProductIds],
        )
      : [];

    report.summary = {
      rows: workbook.rows.length,
      resolved: resolved.length,
      changed: resolved.filter((row) => row.changed).length,
      unchanged: resolved.filter((row) => !row.changed).length,
      missing: missing.length,
      ambiguous: ambiguous.length,
      archived: resolved.filter((row) => row.archived).length,
      storeOverrides: overrides.length,
    };
    report.products = resolved;
    report.missing = missing;
    report.ambiguous = ambiguous;
    report.storeOverrides = overrides;

    const blockers: string[] = [];
    if (!resolved.length) blockers.push('No se concilió ningún producto con la base de datos');
    if (ambiguous.length)
      blockers.push(`${ambiguous.length} códigos tienen más de una coincidencia en la base de datos`);
    if (missing.length && !options.allowMissingProducts)
      blockers.push(`${missing.length} códigos no existen en la base de datos`);
    const archived = resolved.filter((row) => row.archived);
    if (archived.length) blockers.push(`${archived.length} productos conciliados están archivados`);
    if (overrides.length && !options.syncStoreOverrides)
      blockers.push(`${overrides.length} precios por tienda ocultarían el nuevo precio base`);
    report.blockers = blockers;

    if (options.mode === 'execute') {
      if (options.confirmation !== CONFIRMATION) throw new Error(`Para ejecutar añade --confirm ${CONFIRMATION}`);
      if (blockers.length) throw new Error(`Ejecución bloqueada: ${blockers.join('; ')}`);

      const changed = resolved.filter((row) => row.changed);
      await orm.em.fork().transactional(async (tx) => {
        const sql = tx.getConnection();
        await sql.execute('select pg_advisory_xact_lock(hashtext(?))', [`h1-price-update:${organization.id}`]);
        for (const row of changed) {
          const locked = await sql.execute<ProductMatch[]>(
            `select id, name, manufacturer_code, price, parent_id, status, archived_at
             from products
             where id = ?::uuid and organization_id = ?::uuid
               and removed_at is null and archived_at is null
             for update`,
            [row.productId, organization.id],
          );
          if (locked.length !== 1 || locked[0].manufacturer_code.trim().toUpperCase() !== row.code) {
            throw new Error(`El producto ${row.code} cambió durante la conciliación; operación cancelada`);
          }
          await sql.execute(
            `update products set price = ?::numeric, updated_at = now()
             where id = ?::uuid and organization_id = ?::uuid`,
            [row.newPrice, row.productId, organization.id],
          );
        }

        let verifiedOverrideCount = 0;
        if (options.syncStoreOverrides) {
          for (const row of resolved) {
            await sql.execute(
              `update store_products set price = ?::numeric, updated_at = now()
               where organization_id = ?::uuid and product_id = ?::uuid and price is not null`,
              [row.newPrice, organization.id, row.productId],
            );
          }
        }

        for (const parentId of parentIds) {
          const [minimum] = await sql.execute<Array<{ price: string | null }>>(
            `select min(price)::text as price from products
             where organization_id = ?::uuid and parent_id = ?::uuid
               and removed_at is null and archived_at is null`,
            [organization.id, parentId],
          );
          if (minimum?.price !== null && minimum?.price !== undefined) {
            await sql.execute(
              `update products set price = ?::numeric, updated_at = now()
               where id = ?::uuid and organization_id = ?::uuid and removed_at is null`,
              [minimum.price, parentId, organization.id],
            );
            if (options.syncStoreOverrides) {
              await sql.execute(
                `update store_products set price = ?::numeric, updated_at = now()
                 where organization_id = ?::uuid and product_id = ?::uuid and price is not null`,
                [minimum.price, organization.id, parentId],
              );
            }
          }
        }

        const verifiedProducts = await sql.execute<Array<{ id: string; manufacturer_code: string; price: string }>>(
          `select id, manufacturer_code, price::text as price
           from products
           where organization_id = ?::uuid and id in (?)
             and removed_at is null and archived_at is null
           for update`,
          [organization.id, productIds],
        );
        const expectedById = new Map(resolved.map((row) => [row.productId, row]));
        const verificationErrors: string[] = [];
        for (const product of verifiedProducts) {
          const expected = expectedById.get(product.id);
          if (!expected) {
            verificationErrors.push(`El producto ${product.manufacturer_code} no estaba en el plan conciliado`);
            continue;
          }
          if (Number(product.price).toFixed(2) !== expected.newPrice) {
            verificationErrors.push(
              `${expected.code}: se esperaba ${expected.newPrice} y quedó ${Number(product.price).toFixed(2)}`,
            );
          }
        }
        if (verifiedProducts.length !== resolved.length) {
          verificationErrors.push(
            `Se verificaron ${verifiedProducts.length} de ${resolved.length} productos conciliados`,
          );
        }

        const verifiedParents: Array<{ parentId: string; price: string; expectedPrice: string }> = [];
        for (const parentId of parentIds) {
          const [parent] = await sql.execute<Array<{ price: string; expected_price: string | null }>>(
            `select p.price::text as price,
                    (select min(c.price)::text
                     from products c
                     where c.organization_id = p.organization_id and c.parent_id = p.id
                       and c.removed_at is null and c.archived_at is null) as expected_price
             from products p
             where p.id = ?::uuid and p.organization_id = ?::uuid and p.removed_at is null
             for update`,
            [parentId, organization.id],
          );
          if (!parent?.expected_price) {
            verificationErrors.push(`El producto padre ${parentId} no tiene hijos activos con precio`);
            continue;
          }
          verifiedParents.push({ parentId, price: parent.price, expectedPrice: parent.expected_price });
          if (Number(parent.price).toFixed(2) !== Number(parent.expected_price).toFixed(2)) {
            verificationErrors.push(
              `Padre ${parentId}: se esperaba ${Number(parent.expected_price).toFixed(2)} y quedó ${Number(parent.price).toFixed(2)}`,
            );
          }
        }

        if (options.syncStoreOverrides) {
          const expectedOverrides = new Map(resolved.map((row) => [row.productId, row.newPrice]));
          for (const parent of verifiedParents) {
            expectedOverrides.set(parent.parentId, Number(parent.expectedPrice).toFixed(2));
          }
          const verifiedOverrides = affectedProductIds.length
            ? await sql.execute<Array<{ product_id: string; store_name: string; price: string }>>(
                `select sp.product_id, s.name as store_name, sp.price::text as price
                 from store_products sp
                 join stores s on s.id = sp.store_id
                 where sp.organization_id = ?::uuid and sp.product_id in (?) and sp.price is not null
                 order by sp.product_id, s.name`,
                [organization.id, affectedProductIds],
              )
            : [];
          for (const override of verifiedOverrides) {
            const expected = expectedOverrides.get(override.product_id);
            if (!expected) {
              verificationErrors.push(
                `El precio por tienda de ${override.store_name} referencia un producto fuera del plan`,
              );
              continue;
            }
            if (Number(override.price).toFixed(2) !== expected) {
              verificationErrors.push(
                `Precio por tienda ${override.store_name}: se esperaba ${expected} y quedó ${Number(override.price).toFixed(2)}`,
              );
            }
          }
          verifiedOverrideCount = verifiedOverrides.length;
        }

        report.verification = {
          passed: verificationErrors.length === 0,
          directProducts: verifiedProducts.length,
          parentProducts: verifiedParents.length,
          storeOverrides: verifiedOverrideCount,
          errors: verificationErrors,
        };
        if (verificationErrors.length) {
          throw new Error(`La verificación posterior falló: ${verificationErrors.join('; ')}`);
        }
      });
      report.status = 'EXECUTED';
      report.executedAt = new Date().toISOString();
      app.get(CatalogueRevalidationService).request();
    } else {
      report.status = blockers.length ? 'PLAN_BLOCKED' : 'PLANNED';
    }
  } catch (error) {
    report.status = 'FAILED';
    report.error =
      error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Estado: ${report.status}`);
    console.log(`Reporte: ${reportPath}`);
    if (report.summary) console.log(JSON.stringify(report.summary, null, 2));
    await app?.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
