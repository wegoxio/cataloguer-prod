require('dotenv').config();
const { Client } = require('pg');

const channels = [
  {
    key: 'mobiliario', name: 'Mobiliario', isDefault: true,
    navigation: [
      ['sofas', 'Sofás', ['mobiliario-sofas']], ['butacas', 'Butacas', ['mobiliario-butacas']],
      ['mesas', 'Mesas', ['mobiliario-mesas']], ['sillas', 'Sillas / Taburetes', ['mobiliario-sillas-stools']],
      ['aparadores', 'Aparadores / Bar', ['mobiliario-aparadores-bar']], ['estanterias', 'Estanterías', ['mobiliario-estanterias']],
      ['camas', 'Camas', ['mobiliario-camas']], ['sofa-cama', 'Sofás cama', ['mobiliario-sofa-cama']],
      ['gaveteros', 'Gaveteros / Mesas de noche', ['mobiliario-gavetero-mesas-de-noche']],
      ['bancos', 'Bancos / Pufs', ['mobiliario-bancos-pouffs']],
      ['mesas-centro', 'Mesas de centro / Auxiliares', ['mobiliario-mesas-centro', 'mobiliario-mesas-auxiliares']],
      ['bar', 'Bar', ['mobiliario-aparadores-bar']], ['exteriores', 'Exteriores', ['exteriores']],
      ['iluminacion', 'Iluminación', ['iluminacion']], ['alfombras', 'Alfombras', ['textiles-alfombras']],
      ['accesorios', 'Accesorios', ['accesorios']],
    ],
  },
  {
    key: 'mobiliario-h1', name: 'Mobiliario H1', isDefault: false,
    navigation: [
      ['sofas', 'Sofás', ['mobiliario-h1-coleccion-h1-sofas-ch1']],
      ['butacas', 'Butacas', ['mobiliario-h1-coleccion-h1-butacas-ch1']],
      ['mesas', 'Mesas', ['mobiliario-h1-coleccion-h1-mesas-ch1']],
      ['sillas', 'Sillas / Taburetes', ['mobiliario-h1-coleccion-h1-sillas-stools-ch1']],
      ['aparadores', 'Aparadores / Bar', ['mobiliario-h1-coleccion-h1-aparadores-bar-ch1']],
      ['bancos', 'Bancos / Pufs', ['mobiliario-h1-coleccion-h1-bancos-pouffs-ch1']],
      ['mesas-centro', 'Mesas de centro / Auxiliares', ['mobiliario-h1-coleccion-h1-mesas-de-centro-ch1', 'mobiliario-h1-coleccion-h1-mesas-auxiliares-ch1']],
      ['iluminacion', 'Iluminación', ['mobiliario-h1-coleccion-h1-iluminacion-ch1']],
      ['alfombras', 'Alfombras', ['mobiliario-h1-coleccion-h1-alfombras-ch1']],
      ['accesorios', 'Accesorios', ['mobiliario-h1-coleccion-h1-accesorios-ch1']],
    ],
  },
];

const rooms = [
  ['sala', 'Sala', ['sofas', 'butacas', 'mesas', 'sillas', 'aparadores', 'estanterias', 'sofa-cama', 'bancos', 'mesas-centro', 'bar', 'iluminacion', 'alfombras', 'accesorios']],
  ['comedor', 'Comedor', ['mesas', 'sillas', 'aparadores', 'bancos', 'bar', 'iluminacion', 'alfombras', 'accesorios']],
  ['dormitorio', 'Dormitorio', ['butacas', 'estanterias', 'camas', 'sofa-cama', 'gaveteros', 'bancos', 'iluminacion', 'alfombras', 'accesorios']],
  ['oficina', 'Oficina', ['butacas', 'mesas', 'sillas', 'estanterias', 'iluminacion', 'alfombras', 'accesorios']],
  ['cocina', 'Cocina', ['sillas', 'bar', 'accesorios']], ['bano', 'Baño', ['accesorios']],
  ['iluminacion', 'Iluminación', ['iluminacion']], ['accesorios', 'Accesorios', ['exteriores', 'alfombras', 'accesorios']],
];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('begin');
  try {
    const storeResult = await db.query(`select s.id, s.organization_id from stores s join organizations o on o.id=s.organization_id where lower(s.name)=lower('DesignHof Online') and s.archived_at is null limit 1`);
    if (!storeResult.rowCount) throw new Error('DesignHof Online store not found');
    const { id: storeId, organization_id: organizationId } = storeResult.rows[0];
    const categoryRows = await db.query(`select id, slug from categories where organization_id=$1 and archived_at is null and removed_at is null`, [organizationId]);
    const categoryBySlug = new Map(categoryRows.rows.map((row) => [row.slug, row.id]));

    for (let channelOrder = 0; channelOrder < channels.length; channelOrder++) {
      const definition = channels[channelOrder];
      const channelResult = await db.query(`insert into catalogue_channels (organization_id,store_id,key,name,is_default,active,sort_order,created_at,updated_at) values ($1,$2,$3,$4,$5,true,$6,now(),now()) on conflict (store_id,key) do update set name=excluded.name,is_default=excluded.is_default,active=true,sort_order=excluded.sort_order,updated_at=now() returning id`, [organizationId, storeId, definition.key, definition.name, definition.isDefault, channelOrder]);
      const channelId = channelResult.rows[0].id;
      const navigationCategoryIds = new Map();

      for (let order = 0; order < definition.navigation.length; order++) {
        const [key, name, slugs] = definition.navigation[order];
        const categoryIds = slugs.map((slug) => categoryBySlug.get(slug)).filter(Boolean);
        if (!categoryIds.length) continue;
        navigationCategoryIds.set(key, categoryIds);
        for (const categoryId of categoryIds) {
          const cover = await db.query(`select p.id from products p join product_categories pc on pc.product_id=p.id join store_products sp on sp.product_id=p.id and sp.store_id=$1 and sp.published=true where pc.category_id=$2 and p.status='PUBLISHED' and p.archived_at is null and p.removed_at is null and exists(select 1 from product_images pi where pi.product_id=p.id and pi.archived_at is null) order by p.created_at desc limit 1`, [storeId, categoryId]);
          await db.query(`insert into store_category_publications (organization_id,store_id,channel_id,category_id,cover_product_id,placements,visible,sort_order,created_at,updated_at) values($1,$2,$3,$4,$5,'["HOME","CATALOG","NAVIGATION"]'::jsonb,true,$6,now(),now()) on conflict(store_id,channel_id,category_id) do update set cover_product_id=excluded.cover_product_id,placements=excluded.placements,visible=true,sort_order=least(store_category_publications.sort_order,excluded.sort_order),updated_at=now()`, [organizationId, storeId, channelId, categoryId, cover.rows[0]?.id ?? null, order]);
        }
        const flatIds = categoryIds;
        const cover = await db.query(`select p.id from products p join product_categories pc on pc.product_id=p.id join store_products sp on sp.product_id=p.id and sp.store_id=$1 and sp.published=true where pc.category_id=any($2::uuid[]) and p.status='PUBLISHED' and p.archived_at is null and exists(select 1 from product_images pi where pi.product_id=p.id and pi.archived_at is null) order by p.created_at desc limit 1`, [storeId, flatIds]);
        const groupResult = await db.query(`insert into catalogue_groups (organization_id,store_id,channel_id,key,name,purpose,placements,cover_product_id,active,sort_order,created_at,updated_at) values($1,$2,$3,$4,$5,'NAVIGATION','["HOME","CATALOG","NAVIGATION"]'::jsonb,$6,true,$7,now(),now()) on conflict(channel_id,key) do update set name=excluded.name,purpose='NAVIGATION',placements=excluded.placements,cover_product_id=excluded.cover_product_id,active=true,sort_order=excluded.sort_order,updated_at=now() returning id`, [organizationId,storeId,channelId,key,name,cover.rows[0]?.id ?? null,order]);
        await db.query(`delete from catalogue_group_categories where group_id=$1`, [groupResult.rows[0].id]);
        for (let i=0;i<categoryIds.length;i++) await db.query(`insert into catalogue_group_categories(organization_id,store_id,group_id,category_id,sort_order,created_at) values($1,$2,$3,$4,$5,now())`, [organizationId,storeId,groupResult.rows[0].id,categoryIds[i],i]);
      }

      for (let order=0;order<rooms.length;order++) {
        const [key,name,navigationKeys]=rooms[order];
        const categoryIds=[...new Set(navigationKeys.flatMap((navKey)=>navigationCategoryIds.get(navKey) || []))];
        if (!categoryIds.length) continue;
        const groupResult=await db.query(`insert into catalogue_groups(organization_id,store_id,channel_id,key,name,purpose,placements,active,sort_order,created_at,updated_at) values($1,$2,$3,$4,$5,'FILTER','["HOME"]'::jsonb,true,$6,now(),now()) on conflict(channel_id,key) do update set name=excluded.name,purpose='FILTER',placements=excluded.placements,active=true,sort_order=excluded.sort_order,updated_at=now() returning id`,[organizationId,storeId,channelId,`ambiente-${key}`,name,order]);
        await db.query(`delete from catalogue_group_categories where group_id=$1`,[groupResult.rows[0].id]);
        for(let i=0;i<categoryIds.length;i++) await db.query(`insert into catalogue_group_categories(organization_id,store_id,group_id,category_id,sort_order,created_at) values($1,$2,$3,$4,$5,now())`,[organizationId,storeId,groupResult.rows[0].id,categoryIds[i],i]);
      }
    }
    await db.query('commit');
    console.log('DesignHof catalogue navigation configured successfully.');
  } catch (error) { await db.query('rollback'); throw error; } finally { await db.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
