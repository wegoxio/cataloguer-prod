/* eslint-disable no-console */
import 'reflect-metadata';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import ExcelJS = require('exceljs');
import { AppModule } from '../app.module';

const ORGANIZATION = 'DesignHof';
const OUTPUT = process.env.EXPORT_OUTPUT ?? '/tmp/designhof-catalogue-production.xlsx';
const dangerousPrefix = /^[=+\-@\t\r]/;
const safe = (value: unknown): string | number | boolean | Date => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = String(value);
  return dangerousPrefix.test(text) ? `'${text}` : text;
};

type Row = Record<string, unknown>;

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: { header: string; key: string; width: number }[], rows: Row[]) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns;
  for (const row of rows) sheet.addRow(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safe(value)])));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: columns.length } };
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  sheet.eachRow((row, index) => {
    row.alignment = { vertical: 'top', wrapText: index > 1 };
    if (index > 1 && index % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FB' } };
  });
  return sheet;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const em = app.get(MikroORM).em.fork() as EntityManager;
    const orgs: { id: string }[] = await em.execute(`select id from organizations where lower(name)=lower(?)`, [ORGANIZATION]);
    if (orgs.length !== 1) throw new Error(`Expected exactly one ${ORGANIZATION} organization, found ${orgs.length}`);
    const organizationId = orgs[0].id;

    const products: Row[] = await em.execute(
      `select p.id as internal_id, p.name, p.slug, p.sku as internal_sku,
              p.manufacturer_code as supplier_code, p.status, p.sale_mode,
              case when exists(select 1 from products c where c.parent_id=p.id and c.removed_at is null) then 'PARENT'
                   when p.parent_id is not null then 'CHILD' else 'STANDALONE' end as product_role,
              p.parent_id as parent_internal_id, parent.name as parent_name, parent.slug as parent_slug,
              p.option_label, p.description, p.meta_title, p.meta_description,
              p.price::numeric as base_price, p.sale_price::numeric as sale_price, p.cost::numeric as internal_cost,
              p.track_inventory, p.stock_quantity::int as organization_stock_cache,
              coalesce((select sum(b.quantity) from inventory_balances b where b.organization_id=p.organization_id and b.product_id=p.id),0)::int as owned_stock,
              coalesce((select sum(b.quantity) from inventory_balances b where b.organization_id=p.organization_id and b.product_id=p.id and b.operational_state='AVAILABLE'),0)::int as available_stock,
              coalesce((select sum(b.quantity) from inventory_balances b where b.organization_id=p.organization_id and b.product_id=p.id and b.operational_state='RESERVED'),0)::int as reserved_stock,
              coalesce((select string_agg(c.name, ' | ' order by c.name) from product_categories pc join categories c on c.id=pc.category_id where pc.product_id=p.id),'') as category_names,
              coalesce((select string_agg(c.slug, ' | ' order by c.slug) from product_categories pc join categories c on c.id=pc.category_id where pc.product_id=p.id),'') as category_slugs,
              coalesce((select string_agg(s.name, ' | ' order by s.name) from store_products sp join stores s on s.id=sp.store_id where sp.product_id=p.id),'') as stores,
              coalesce((select string_agg(s.name, ' | ' order by s.name) from store_products sp join stores s on s.id=sp.store_id where sp.product_id=p.id and sp.published),'') as published_stores,
              (select count(*)::int from product_images i where i.product_id=p.id and i.archived_at is null) as image_count,
              (select i.url from product_images i where i.product_id=p.id and i.archived_at is null order by i.is_primary desc, i.sort_order, i.id limit 1) as primary_image_url,
              p.created_at, p.updated_at, p.archived_at, p.removed_at
         from products p left join products parent on parent.id=p.parent_id
        where p.organization_id=?::uuid order by p.name, p.id`,
      [organizationId],
    );

    const stores: Row[] = await em.execute(
      `select p.id as product_internal_id, p.name as product_name, p.slug, p.sku as internal_sku,
              p.manufacturer_code as supplier_code, s.name as store_name, s.slug as store_slug,
              sp.published, sp.price::numeric as store_price_override, sp.sale_price::numeric as store_sale_price_override,
              sp.cost::numeric as store_internal_cost, sp.track_inventory, sp.stock_quantity::int as store_stock_cache,
              coalesce((select sum(b.quantity) from inventory_balances b join inventory_locations l on l.id=b.location_id
                         where b.organization_id=p.organization_id and b.product_id=p.id and l.store_id=s.id and b.operational_state='AVAILABLE'),0)::int as available_stock,
              coalesce((select sum(b.quantity) from inventory_balances b join inventory_locations l on l.id=b.location_id
                         where b.organization_id=p.organization_id and b.product_id=p.id and l.store_id=s.id and b.operational_state='RESERVED'),0)::int as reserved_stock,
              sp.lead_time_days, sp.updated_at
         from store_products sp join products p on p.id=sp.product_id join stores s on s.id=sp.store_id
        where p.organization_id=?::uuid order by p.name, s.name`,
      [organizationId],
    );

    const categories: Row[] = await em.execute(
      `select c.id as internal_id, c.name, c.slug, c.description, parent.name as parent_name, parent.slug as parent_slug,
              c.kind, c.public_label, c.sort_order, c.show_in_navigation,
              (select count(*)::int from product_categories pc where pc.category_id=c.id) as product_count,
              c.created_at, c.updated_at, c.archived_at, c.removed_at
         from categories c left join categories parent on parent.id=c.parent_category_id
        where c.organization_id=?::uuid order by coalesce(parent.name,''), c.name`,
      [organizationId],
    );

    const images: Row[] = await em.execute(
      `select p.id as product_internal_id, p.name as product_name, p.slug, p.sku as internal_sku,
              i.id as image_internal_id, i.is_primary, i.sort_order, i.alt_text, i.display_mode,
              i.url, i.source_url, i.storage_key, i.created_at, i.archived_at
         from product_images i join products p on p.id=i.product_id
        where p.organization_id=?::uuid order by p.name, i.is_primary desc, i.sort_order, i.id`,
      [organizationId],
    );

    const fields: Row[] = await em.execute(
      `select p.id as product_internal_id, p.name as product_name, p.slug, p.sku as internal_sku,
              d.key as field_key, d.label as field_name, d.type as field_type, d.unit,
              coalesce(v.value_text, v.value_number::text, v.value_boolean::text, v.value_date::text) as field_value,
              d.applicability, d.source, d.archived_at as definition_archived_at, v.updated_at
         from product_field_values v join products p on p.id=v.product_id
         join product_field_definitions d on d.id=v.definition_id
        where p.organization_id=?::uuid order by p.name, d.sort_order, d.label`,
      [organizationId],
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Wegox Cataloguer';
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.properties.date1904 = false;

    addSheet(workbook, 'Resumen', [
      { header: 'Métrica', key: 'metric', width: 38 }, { header: 'Valor', key: 'value', width: 24 }, { header: 'Descripción', key: 'description', width: 80 },
    ], [
      { metric: 'Fecha de exportación (UTC)', value: new Date().toISOString(), description: 'Copia de solo lectura generada directamente desde producción.' },
      { metric: 'Organización', value: ORGANIZATION, description: 'Empresa incluida en este archivo.' },
      { metric: 'Productos totales', value: products.length, description: 'Incluye activos, archivados y removidos para reflejar el estado real.' },
      { metric: 'Productos publicados', value: products.filter((p) => p.status === 'PUBLISHED' && !p.archived_at && !p.removed_at).length, description: 'Publicados a nivel de catálogo.' },
      { metric: 'Productos archivados', value: products.filter((p) => Boolean(p.archived_at)).length, description: 'No deberían mostrarse al público.' },
      { metric: 'Categorías', value: categories.length, description: 'Incluye jerarquía y conteo de productos.' },
      { metric: 'Imágenes', value: images.length, description: 'Una fila por imagen.' },
      { metric: 'Importación futura', value: 'Usar hoja Productos', description: 'No modificar internal_id. supplier_code es el código del proveedor; internal_sku es el identificador propio de DesignHof/Cataloguer.' },
    ]);

    addSheet(workbook, 'Productos', [
      ['ID interno (no editar)','internal_id',38], ['Nombre','name',42], ['Slug','slug',42], ['SKU interno DesignHof','internal_sku',24], ['Código proveedor','supplier_code',24],
      ['Estado','status',14], ['Modo venta','sale_mode',14], ['Rol','product_role',14], ['ID padre','parent_internal_id',38], ['Producto padre','parent_name',36], ['Slug padre','parent_slug',36], ['Opción/variante','option_label',24],
      ['Descripción','description',70], ['SEO título','meta_title',40], ['SEO descripción','meta_description',65], ['Precio base','base_price',14], ['Precio oferta','sale_price',14], ['Costo interno','internal_cost',14],
      ['Controla inventario','track_inventory',18], ['Stock caché empresa','organization_stock_cache',18], ['Stock total propio','owned_stock',18], ['Stock disponible','available_stock',18], ['Stock reservado','reserved_stock',18],
      ['Categorías','category_names',65], ['Slugs categorías (importación)','category_slugs',65], ['Tiendas asignadas','stores',35], ['Tiendas publicadas','published_stores',35], ['Nº imágenes','image_count',12], ['Imagen principal','primary_image_url',70],
      ['Creado','created_at',22], ['Actualizado','updated_at',22], ['Archivado','archived_at',22], ['Eliminado','removed_at',22],
    ].map(([header,key,width]) => ({ header: String(header), key: String(key), width: Number(width) })), products);

    addSheet(workbook, 'Inventario por tienda', [
      ['ID producto','product_internal_id',38], ['Producto','product_name',42], ['Slug','slug',38], ['SKU interno','internal_sku',22], ['Código proveedor','supplier_code',22], ['Tienda','store_name',28], ['Slug tienda','store_slug',28],
      ['Publicado','published',12], ['Precio tienda','store_price_override',15], ['Oferta tienda','store_sale_price_override',15], ['Costo interno tienda','store_internal_cost',18], ['Controla inventario','track_inventory',18],
      ['Stock caché tienda','store_stock_cache',18], ['Stock disponible real','available_stock',20], ['Stock reservado','reserved_stock',18], ['Días entrega','lead_time_days',14], ['Actualizado','updated_at',22],
    ].map(([header,key,width]) => ({ header: String(header), key: String(key), width: Number(width) })), stores);

    addSheet(workbook, 'Categorías', [
      ['ID interno','internal_id',38], ['Nombre','name',38], ['Slug','slug',38], ['Descripción','description',65], ['Categoría superior','parent_name',38], ['Slug superior','parent_slug',38], ['Tipo','kind',18], ['Título público','public_label',30], ['Orden','sort_order',10], ['En navegación','show_in_navigation',15], ['Nº productos','product_count',14], ['Creada','created_at',22], ['Actualizada','updated_at',22], ['Archivada','archived_at',22], ['Eliminada','removed_at',22],
    ].map(([header,key,width]) => ({ header: String(header), key: String(key), width: Number(width) })), categories);

    addSheet(workbook, 'Imágenes', [
      ['ID producto','product_internal_id',38], ['Producto','product_name',42], ['Slug','slug',38], ['SKU interno','internal_sku',22], ['ID imagen','image_internal_id',38], ['Principal','is_primary',12], ['Orden','sort_order',10], ['Texto alternativo','alt_text',38], ['Modo','display_mode',12], ['URL pública','url',75], ['URL origen','source_url',75], ['Clave almacenamiento','storage_key',65], ['Creada','created_at',22], ['Archivada','archived_at',22],
    ].map(([header,key,width]) => ({ header: String(header), key: String(key), width: Number(width) })), images);

    addSheet(workbook, 'Campos personalizados', [
      ['ID producto','product_internal_id',38], ['Producto','product_name',42], ['Slug','slug',38], ['SKU interno','internal_sku',22], ['Clave campo','field_key',28], ['Campo','field_name',32], ['Tipo','field_type',14], ['Unidad','unit',12], ['Valor','field_value',45], ['Aplicabilidad','applicability',16], ['Origen','source',14], ['Definición archivada','definition_archived_at',22], ['Actualizado','updated_at',22],
    ].map(([header,key,width]) => ({ header: String(header), key: String(key), width: Number(width) })), fields);

    for (const sheet of workbook.worksheets) {
      sheet.getColumn(1).alignment = { vertical: 'top' };
      sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    }
    await workbook.xlsx.writeFile(path.resolve(OUTPUT));
    console.log(JSON.stringify({ output: path.resolve(OUTPUT), products: products.length, stores: stores.length, categories: categories.length, images: images.length, customFields: fields.length }));
  } finally {
    await app.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
