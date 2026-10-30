/* eslint-disable no-console */
import 'reflect-metadata';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import readXlsxFile from 'read-excel-file/node';
import * as sharpModule from 'sharp';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppModule } from '../app.module';
import { InventoryStockService } from '../modules/inventory/ledger/inventory-stock.service';
import { CatalogueRevalidationService } from '../common/catalogue-revalidation/catalogue-revalidation.service';

type Mode = 'analyze' | 'plan' | 'execute';
type Row = { excelRow: number; itemNumber: string; profitCode: string; name: string; quantity: number; price: string; sourceCategory: string; categorySlugs: string[]; images: string[] };
type Aliases = Record<string, { prefixes?: string[]; files?: string[] }>;
const CONFIRMATION = 'IMPORT_H1_PRODUCTS';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const MAX_IMAGE_BYTES = 600 * 1024;
// Sharp exposes a CommonJS callable while its current declarations are ESM-shaped
// under this repository's legacy TypeScript module resolution.
const sharp: any = sharpModule;

function args(argv: string[]) {
  const mode = (argv[0] ?? 'analyze') as Mode;
  if (!['analyze', 'plan', 'execute'].includes(mode)) throw new Error(`Modo desconocido: ${mode}`);
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Argumento inesperado: ${argv[i]}`);
    const key = argv[i].slice(2);
    flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return {
    mode,
    workbook: path.resolve(String(flags.workbook ?? 'mercancia en transito H1(1).xlsx')),
    imagesDir: path.resolve(String(flags.images ?? path.join('..', 'Nuevo H1 Octubre 2026 CROP CUADRADO'))),
    aliases: path.resolve(String(flags.aliases ?? path.join(__dirname, 'h1-image-aliases.json'))),
    categoryMap: path.resolve(String(flags['category-map'] ?? path.join(__dirname, 'h1-category-map.json'))),
    organization: String(flags.organization ?? 'DesignHof'), store: String(flags.store ?? 'DesignHof Online'),
    categorySlug: String(flags['category-slug'] ?? 'new-in'), confirmation: String(flags.confirm ?? ''),
    allowMissingImages: flags['allow-missing-images'] === true,
    verifyImages: flags['verify-images'] === true,
    reportDir: path.resolve(String(flags['report-dir'] ?? process.env.H1_IMPORT_REPORT_DIR ?? (process.env.NODE_ENV === 'production' ? '/tmp/cataloguer-h1-reports' : path.join('reports', 'h1-import')))),
  };
}

export function slugify(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
export function money(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Precio inválido: ${String(value)}`);
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}
const txt = (value: unknown) => String(value ?? '').trim();

async function readRows(workbookPath: string, categoryMapPath: string): Promise<Row[]> {
  const book = (await readXlsxFile(workbookPath)) as unknown as Array<{ data: unknown[][] }>;
  const data = book[0]?.data;
  if (!data?.length) throw new Error('El Excel no contiene filas');
  const expected = ['Item no.', 'COD PROFIT', 'Item name', 'Qty.', 'Precio con IVA'];
  const headers = data[0].map(txt);
  if (JSON.stringify(headers.slice(0, 5)) !== JSON.stringify(expected) || headers.length < 6) throw new Error(`Columnas inesperadas; deben comenzar con: ${expected.join(' | ')} y terminar con la categoría`);
  const categoryMap = JSON.parse(await fs.readFile(categoryMapPath, 'utf8')) as Record<string, string[]>;
  const rows = data.slice(1).filter((r) => r.some((v) => v !== null && txt(v))).map((r, index) => {
    const sourceCategory = txt(r[5]).toUpperCase();
    const row: Row = { excelRow: index + 2, itemNumber: txt(r[0]), profitCode: txt(r[1]).toUpperCase(), name: txt(r[2]), quantity: Number(r[3]), price: money(r[4]), sourceCategory, categorySlugs: categoryMap[sourceCategory] ?? [], images: [] };
    if (!/^\d+$/.test(row.itemNumber)) throw new Error(`Fila ${row.excelRow}: Item no. inválido`);
    if (!/^H\d+$/.test(row.profitCode)) throw new Error(`Fila ${row.excelRow}: COD PROFIT inválido`);
    if (!row.name) throw new Error(`Fila ${row.excelRow}: nombre vacío`);
    if (!Number.isInteger(row.quantity) || row.quantity < 0) throw new Error(`Fila ${row.excelRow}: cantidad inválida`);
    if (!row.sourceCategory) throw new Error(`Fila ${row.excelRow}: categoría vacía`);
    if (!row.categorySlugs.length) throw new Error(`Fila ${row.excelRow}: categoría '${row.sourceCategory}' sin mapeo en ${categoryMapPath}`);
    return row;
  });
  for (const key of ['itemNumber', 'profitCode'] as const) {
    const seen = new Set<string>(); const dup = new Set<string>();
    rows.forEach((r) => (seen.has(r[key]) ? dup.add(r[key]) : seen.add(r[key])));
    if (dup.size) throw new Error(`Duplicados en ${key}: ${[...dup].join(', ')}`);
  }
  return rows;
}

async function matchImages(rows: Row[], imagesDir: string, aliasesPath: string) {
  const aliases = JSON.parse(await fs.readFile(aliasesPath, 'utf8')) as Aliases;
  const files = (await fs.readdir(imagesDir, { withFileTypes: true })).filter((f) => f.isFile() && IMAGE_EXTENSIONS.has(path.extname(f.name).toLowerCase())).map((f) => f.name);
  const claimed = new Map<string, string>();
  for (const row of rows) {
    const alias = aliases[row.profitCode] ?? {};
    const prefixes = [row.profitCode, ...(alias.prefixes ?? [])].map((x) => x.toUpperCase());
    const exact = new Set(alias.files ?? []);
    row.images = files.filter((name) => prefixes.some((p) => name.toUpperCase().startsWith(p)) || exact.has(name)).sort(new Intl.Collator(undefined, { numeric: true }).compare);
    row.images.forEach((name) => { const old = claimed.get(name); if (old && old !== row.profitCode) throw new Error(`${name} coincide con ${old} y ${row.profitCode}`); claimed.set(name, row.profitCode); });
  }
  return { count: files.length, orphans: files.filter((name) => !claimed.has(name)) };
}

async function optimize(file: string) {
  let quality = 88; let bytes = Buffer.alloc(0);
  try {
    do {
      bytes = await sharp(file, { failOn: 'none' }).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality, effort: 5 }).toBuffer();
      quality -= 8;
    } while (bytes.length > MAX_IMAGE_BYTES && quality >= 48);
  } catch (error: any) {
    throw new Error(`Imagen inválida ${path.basename(file)}: ${error?.message ?? String(error)}`);
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${path.basename(file)} no pudo reducirse a 600 KiB`);
  return { bytes, quality: quality + 8, hash: createHash('sha256').update(bytes).digest('hex') };
}
const urlFor = (base: string, key: string) => `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
async function objectExists(s3: S3Client, bucket: string, key: string) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (e: any) {
    const status = e?.$metadata?.httpStatusCode;
    // S3 intentionally returns 403, not 404, for a missing key when the
    // principal has object access but no ListBucket. The runtime role is kept
    // that way so it cannot enumerate client assets. PutObject remains the
    // authoritative credential/authorization check immediately afterwards.
    if (status === 403 || status === 404 || e?.name === 'NotFound') return false;
    throw e;
  }
}

async function run() {
  const options = args(process.argv.slice(2)); const started = new Date();
  const report: any = { mode: options.mode, startedAt: started.toISOString(), options, status: 'RUNNING', summary: {}, products: [], warnings: [], errors: [] };
  const reportDir = options.reportDir; await fs.mkdir(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `${started.toISOString().replace(/[:.]/g, '-')}-${options.mode}.json`);
  const checkpoint = async () => fs.writeFile(reportFile, JSON.stringify({ ...report, checkpointAt: new Date().toISOString() }, null, 2));
  let app: any; const uploaded: Array<{ bucket: string; key: string }> = [];
  try {
    const rows = await readRows(options.workbook, options.categoryMap); const imageSet = await matchImages(rows, options.imagesDir, options.aliases);
    const missing = rows.filter((r) => !r.images.length);
    report.summary = { rows: rows.length, units: rows.reduce((n, r) => n + r.quantity, 0), sourceImages: imageSet.count, matchedImages: rows.reduce((n, r) => n + r.images.length, 0), missingImageProducts: missing.map((r) => r.profitCode), orphanImages: imageSet.orphans };
    report.products = rows.map((r) => ({ ...r, action: 'NOT_PLANNED', imageResults: [] }));
    await checkpoint();
    if (missing.length && !options.allowMissingImages) throw new Error(`Productos sin imagen: ${missing.map((r) => `${r.profitCode} (${r.name})`).join(', ')}. Corrija la fuente o use conscientemente --allow-missing-images.`);
    if (imageSet.orphans.length) report.warnings.push(`Imágenes no asignadas: ${imageSet.orphans.join(', ')}`);
    if (options.verifyImages) {
      let outputBytes = 0;
      for (const row of rows) for (const image of row.images) outputBytes += (await optimize(path.join(options.imagesDir, image))).bytes.length;
      report.summary.imageVerification = { verified: report.summary.matchedImages, outputBytes, allWithinLimit: true };
    }
    if (options.mode === 'analyze') { report.status = 'ANALYZED'; return; }

    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const orm = app.get(MikroORM) as MikroORM; const em = orm.em.fork(); const db = em.getConnection();
    const [organization] = await db.execute(`select id, name from organizations where lower(name)=lower(?) and archived_at is null and removed_at is null`, [options.organization]);
    if (!organization) throw new Error(`No existe la organización activa ${options.organization}`);
    const [store] = await db.execute(`select id, name from stores where organization_id=?::uuid and lower(name)=lower(?) and archived_at is null and removed_at is null`, [organization.id, options.store]);
    if (!store) throw new Error(`No existe la tienda activa ${options.store}`);
    const [category] = await db.execute(`select id,name,slug from categories where organization_id=?::uuid and lower(slug)=lower(?) and archived_at is null`, [organization.id, options.categorySlug]);
    if (!category) {
      const available = await db.execute(`select name,slug,kind from categories where organization_id=?::uuid and archived_at is null order by name`, [organization.id]);
      throw new Error(`No existe la categoría activa '${options.categorySlug}'. Categorías disponibles: ${available.map((c: any) => `${c.name} [${c.slug}]`).join(', ')}`);
    }
    const requestedSpecificSlugs = [...new Set(rows.flatMap((row) => row.categorySlugs))];
    const specificCategories = await db.execute(`select id,name,slug from categories where organization_id=?::uuid and slug in (?) and archived_at is null`, [organization.id, requestedSpecificSlugs]);
    const foundSpecificSlugs = new Set(specificCategories.map((candidate: any) => candidate.slug));
    const absentSpecificSlugs = requestedSpecificSlugs.filter((slug) => !foundSpecificSlugs.has(slug));
    if (absentSpecificSlugs.length) throw new Error(`Categorías específicas inexistentes o archivadas: ${absentSpecificSlugs.join(', ')}`);
    const categoryBySlug = new Map(specificCategories.map((candidate: any) => [candidate.slug, candidate]));
    const existing = await db.execute(`select id,name,slug,sku,manufacturer_code,price,status,stock_quantity from products where organization_id=?::uuid and removed_at is null and (upper(manufacturer_code) in (?) or sku in (?))`, [organization.id, rows.map((r) => r.profitCode), rows.map((r) => r.itemNumber)]);
    const usedSlugs = new Set<string>((await db.execute(`select slug from products where organization_id=?::uuid and removed_at is null`, [organization.id])).map((r: any) => r.slug));
    for (const p of report.products) {
      const profit = existing.filter((x: any) => String(x.manufacturer_code ?? '').toUpperCase() === p.profitCode); const sku = existing.filter((x: any) => String(x.sku ?? '') === p.itemNumber);
      if (profit.length > 1 || sku.length > 1) throw new Error(`${p.profitCode}: identidad ambigua en la BD`);
      if (profit[0] && sku[0] && profit[0].id !== sku[0].id) throw new Error(`${p.profitCode}: Profit y SKU apuntan a productos distintos`);
      const found = profit[0] ?? sku[0]; p.id = found?.id ?? randomUUID(); p.action = found ? 'UPDATE' : 'CREATE'; p.before = found ?? null;
      p.slug = found?.slug ?? slugify(p.name); if (!found && usedSlugs.has(p.slug)) p.slug += `-${p.profitCode.toLowerCase()}`; usedSlugs.add(p.slug);
    }
    report.summary.databasePlan = {
      create: report.products.filter((p: any) => p.action === 'CREATE').length,
      update: report.products.filter((p: any) => p.action === 'UPDATE').length,
    };
    report.target = { organization, store, newInCategory: category, specificCategories };
    report.summary.categoryAssignments = Object.fromEntries(rows.reduce((counts, row) => {
      counts.set(row.sourceCategory, (counts.get(row.sourceCategory) ?? 0) + 1); return counts;
    }, new Map<string, number>()));
    report.status = 'PLANNED';
    if (options.mode === 'plan') return;
    if (options.confirmation !== CONFIRMATION) throw new Error(`Use --confirm ${CONFIRMATION} después de revisar el plan.`);
    const bucket = process.env.STORAGE_BUCKET; const region = process.env.STORAGE_REGION; const base = process.env.STORAGE_PUBLIC_URL;
    if (!bucket || !region || !base) throw new Error('Faltan STORAGE_BUCKET, STORAGE_REGION o STORAGE_PUBLIC_URL');
    const credentials = process.env.STORAGE_ACCESS_KEY_ID && process.env.STORAGE_SECRET_ACCESS_KEY ? { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY } : undefined;
    const s3 = new S3Client({ region, endpoint: process.env.STORAGE_ENDPOINT || undefined, forcePathStyle: Boolean(process.env.STORAGE_ENDPOINT), credentials });
    for (const p of report.products) {
      for (let i = 0; i < p.images.length; i++) {
        const source = p.images[i]; const out = await optimize(path.join(options.imagesDir, source)); const key = `products/${p.id}/h1/${String(i + 1).padStart(2, '0')}-${out.hash.slice(0, 16)}.webp`; const existed = await objectExists(s3, bucket, key);
        if (!existed) { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: out.bytes, ContentType: 'image/webp', CacheControl: 'public,max-age=31536000,immutable', Metadata: { profit: p.profitCode } })); uploaded.push({ bucket, key }); }
        p.imageResults.push({ source, key, url: urlFor(base, key), hash: out.hash, bytes: out.bytes.length, quality: out.quality, uploaded: !existed });
      }
      report.currentProduct = p.profitCode;
      await checkpoint();
    }
    const inventory = app.get(InventoryStockService) as InventoryStockService;
    await em.transactional(async (tx) => {
      const sql = tx.getConnection(); await sql.execute(`select pg_advisory_xact_lock(hashtext(?))`, [`h1-import:${organization.id}`]);
      for (const p of report.products) {
        if (p.action === 'CREATE') await sql.execute(`insert into products(id,name,slug,sku,manufacturer_code,status,sale_mode,organization_id,price,stock_quantity,track_inventory,created_at,updated_at) values(?::uuid,?,?,?,?,'PUBLISHED','DIRECT',?::uuid,?::numeric,?,true,now(),now())`, [p.id,p.name,p.slug,p.itemNumber,p.profitCode,organization.id,p.price,p.quantity]);
        else await sql.execute(`update products set name=?,sku=?,manufacturer_code=?,status='PUBLISHED',price=?::numeric,stock_quantity=?,track_inventory=true,archived_at=null,updated_at=now() where id=?::uuid and organization_id=?::uuid`, [p.name,p.itemNumber,p.profitCode,p.price,p.quantity,p.id,organization.id]);
        await sql.execute(`insert into store_products(id,organization_id,store_id,product_id,published,price,stock_quantity,track_inventory,created_at,updated_at) values(gen_random_uuid(),?::uuid,?::uuid,?::uuid,true,null,?,true,now(),now()) on conflict(store_id,product_id) do update set published=true,stock_quantity=excluded.stock_quantity,track_inventory=true,updated_at=now()`, [organization.id,store.id,p.id,p.quantity]);
        const assignmentIds = [category.id, ...p.categorySlugs.map((slug: string) => (categoryBySlug.get(slug) as any).id)];
        for (const categoryId of new Set(assignmentIds)) await sql.execute(`insert into product_categories(product_id,category_id) values(?::uuid,?::uuid) on conflict do nothing`, [p.id,categoryId]);
        const oldImages = await sql.execute(`select id,content_hash,source_url,is_primary from product_images where product_id=?::uuid and archived_at is null`, [p.id]); let primary = oldImages.some((x: any) => x.is_primary);
        for (let i = 0; i < p.imageResults.length; i++) { const image = p.imageResults[i]; const sourceUrl = `h1-import:${image.source}`; const old = oldImages.find((x: any) => x.content_hash === image.hash || x.source_url === sourceUrl);
          if (old) await sql.execute(`update product_images set url=?,storage_key=?,source_url=?,content_hash=?,alt_text=?,sort_order=?,archived_at=null where id=?::uuid`, [image.url,image.key,sourceUrl,image.hash,p.name,i,old.id]);
          else { const isPrimary = !primary && i === 0; await sql.execute(`insert into product_images(id,product_id,url,storage_key,source_url,content_hash,alt_text,is_primary,display_mode,sort_order,created_at) values(gen_random_uuid(),?::uuid,?,?,?,?,?,?,'CONTAIN',?,now())`, [p.id,image.url,image.key,sourceUrl,image.hash,p.name,isPrimary,i]); if (isPrimary) primary = true; }
        }
        p.inventory = await inventory.setBranchQuantity(tx as any, { organizationId: organization.id, storeId: store.id, productId: p.id, targetQuantity: p.quantity, origin: 'h1-excel-import' }); p.result = 'IMPORTED';
      }
    });
    app.get(CatalogueRevalidationService).request();
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    report.status = 'EXECUTED';
  } catch (e: any) {
    report.status = 'FAILED'; report.errors.push({
      name: e?.name,
      message: e?.message ?? String(e),
      httpStatus: e?.$metadata?.httpStatusCode,
      requestId: e?.$metadata?.requestId,
      stack: e?.stack,
    }); process.exitCode = 1;
    if (uploaded.length) try {
      const cleanupCredentials = process.env.STORAGE_ACCESS_KEY_ID && process.env.STORAGE_SECRET_ACCESS_KEY ? { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY } : undefined;
      const s3 = new S3Client({ region: process.env.STORAGE_REGION!, endpoint: process.env.STORAGE_ENDPOINT || undefined, forcePathStyle: Boolean(process.env.STORAGE_ENDPOINT), credentials: cleanupCredentials });
      await Promise.all(uploaded.map((x) => s3.send(new DeleteObjectCommand({ Bucket: x.bucket, Key: x.key })))); report.rollback = { deletedObjects: uploaded.length };
    } catch (cleanup: any) { report.rollback = { error: cleanup?.message, objects: uploaded }; }
  } finally {
    report.finishedAt = new Date().toISOString(); await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); if (app) await app.close(); console.log(`Estado: ${report.status}\nReporte: ${reportFile}\n${JSON.stringify(report.summary, null, 2)}`);
  }
}
if (require.main === module) void run();
