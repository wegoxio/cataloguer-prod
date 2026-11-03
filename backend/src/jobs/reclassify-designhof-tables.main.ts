/* eslint-disable no-console */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client, PoolClient } from 'pg';
import { parseRevalidationTargets } from '../common/catalogue-revalidation/revalidation-targets';

type Mode = 'analyze' | 'plan' | 'execute';
type Target = 'DINING' | 'CENTER_AUX' | 'DESK';
type Catalogue = 'GENERAL' | 'H1';
type ProductRow = {
  id: string;
  name: string;
  manufacturer_code: string | null;
  slugs: string[];
};
type Decision = {
  productId: string;
  manufacturerCode: string | null;
  name: string;
  catalogue?: Catalogue;
  target?: Target;
  status: 'MIGRATE' | 'REVIEW';
  reason?: string;
  before: string[];
  after?: string[];
};

const CONFIRMATION = 'RECLASSIFY_DESIGNHOF_TABLES';
const GENERAL_ROOT = 'mobiliario';
const H1_ROOT = 'mobiliario-h1-coleccion-h1';
const NEW_IN = 'new-in';

async function revalidateStorefronts(): Promise<string[]> {
  const warnings: string[] = [];
  const targets = parseRevalidationTargets(
    process.env.CATALOGUE_REVALIDATION_TARGETS,
    process.env.NODE_ENV === 'production',
  );
  await Promise.all(
    targets.map(async (target) => {
      const timestamp = Date.now().toString();
      const body = JSON.stringify({ tag: 'cataloguer', timestamp });
      const signature = createHmac('sha256', target.secret).update(`${timestamp}.${body}`).digest('hex');
      try {
        const response = await fetch(target.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cataloguer-timestamp': timestamp,
            'x-cataloguer-signature': `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) warnings.push(`${target.name}: HTTP ${response.status}`);
      } catch (error) {
        warnings.push(`${target.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  return warnings;
}

const source = {
  generalGeneric: 'mobiliario-mesas',
  generalDining: 'mobiliario-mesas-comedor',
  generalCenter: 'mobiliario-mesas-centro',
  generalAux: 'mobiliario-mesas-auxiliares',
  generalDesk: 'mobiliario-mesas-escritorios',
  h1Generic: 'mobiliario-h1-coleccion-h1-mesas-ch1',
  h1Dining: 'mobiliario-h1-coleccion-h1-mesas-de-comedor-ch1',
  h1Center: 'mobiliario-h1-coleccion-h1-mesas-de-centro-ch1',
  h1Aux: 'mobiliario-h1-coleccion-h1-mesas-auxiliares-ch1',
} as const;

const targets: Record<Catalogue, Record<Target, { slug: string; name: string; order: number }>> = {
  GENERAL: {
    DINING: { slug: source.generalDining, name: 'Mesas de comedor', order: 2 },
    CENTER_AUX: { slug: 'mobiliario-mesas-centro-auxiliares', name: 'Mesas de centro y auxiliares', order: 3 },
    DESK: { slug: source.generalDesk, name: 'Escritorios', order: 4 },
  },
  H1: {
    DINING: { slug: source.h1Dining, name: 'Mesas de comedor', order: 2 },
    CENTER_AUX: { slug: 'mobiliario-h1-mesas-centro-auxiliares', name: 'Mesas de centro y auxiliares', order: 3 },
    DESK: { slug: 'mobiliario-h1-escritorios', name: 'Escritorios', order: 4 },
  },
};

const tableSlugs = new Set([
  source.generalGeneric,
  source.generalDining,
  source.generalCenter,
  source.generalAux,
  source.generalDesk,
  source.h1Generic,
  source.h1Dining,
  source.h1Center,
  source.h1Aux,
  'mobiliario-mesas-auxiliares-auxiliares-stock',
  'mobiliario-mesas-centro-centro-stock',
  'mobiliario-mesas-comedor-comedor-stock',
  'mobiliario-mesas-escritorios-escritorios-stock',
  'mobiliario-h1-stock-ch1-mesas-stock-ch1',
  'mobiliario-h1-stock-ch1-mesas-comedor-stock-ch1',
  'mobiliario-h1-stock-ch1-mesas-de-centro-stock-ch1',
  'mobiliario-h1-stock-ch1-mesas-auxiliares-stock-ch1',
]);

const competingNonTable = [/bancos-pouffs/, /sillas-stools/, /aparadores-bar/, /gavetero-mesas-de-noche/];

function options(argv: string[]) {
  const mode = (argv[0] ?? 'analyze') as Mode;
  if (!['analyze', 'plan', 'execute'].includes(mode)) throw new Error(`Modo desconocido: ${mode}`);
  const flags: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) throw new Error(`Argumento inesperado: ${argv[index]}`);
    flags[argv[index].slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
  }
  return {
    mode,
    organization: flags.organization ?? 'DesignHof',
    store: flags.store ?? 'DesignHof Online',
    confirmation: flags.confirm ?? '',
    reportDir: path.resolve(
      flags['report-dir'] ??
        process.env.TABLE_RECLASSIFICATION_REPORT_DIR ??
        path.join('reports', 'table-reclassification'),
    ),
  };
}

const has = (product: ProductRow, slug: string) => product.slugs.includes(slug);

export function decide(product: ProductRow): Decision | null {
  if (!product.slugs.some((slug) => tableSlugs.has(slug))) return null;
  const h1 =
    product.slugs.some((slug) => slug.startsWith('mobiliario-h1')) ||
    (has(product, NEW_IN) && /^H\d+$/i.test(product.manufacturer_code ?? ''));
  const catalogue: Catalogue = h1 ? 'H1' : 'GENERAL';
  const evidence = new Set<Target>();
  if (has(product, source.generalDesk)) evidence.add('DESK');
  if (has(product, source.generalDining) || has(product, source.h1Dining)) evidence.add('DINING');
  if ([source.generalCenter, source.generalAux, source.h1Center, source.h1Aux].some((slug) => has(product, slug)))
    evidence.add('CENTER_AUX');

  const base = {
    productId: product.id,
    manufacturerCode: product.manufacturer_code,
    name: product.name,
    catalogue,
    before: product.slugs,
  };
  const conflicts = product.slugs.filter(
    (slug) => !tableSlugs.has(slug) && competingNonTable.some((pattern) => pattern.test(slug)),
  );
  if (conflicts.length)
    return { ...base, status: 'REVIEW', reason: `También pertenece a categorías no-mesa: ${conflicts.join(', ')}` };
  if (evidence.size === 0)
    return { ...base, status: 'REVIEW', reason: 'Solo tiene la categoría genérica Mesa; no se infiere por el nombre' };
  if (evidence.size > 1)
    return { ...base, status: 'REVIEW', reason: `Clasificaciones incompatibles: ${[...evidence].join(', ')}` };
  return { ...base, status: 'MIGRATE', target: [...evidence][0] };
}

async function categoryId(db: PoolClient | Client, organizationId: string, slug: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select id from categories where organization_id=$1 and slug=$2 and removed_at is null limit 1`,
    [organizationId, slug],
  );
  if (!result.rowCount) throw new Error(`No existe la categoría requerida ${slug}`);
  return result.rows[0].id;
}

async function ensureCategory(
  db: PoolClient | Client,
  organizationId: string,
  definition: { slug: string; name: string; order: number },
  parentId: string,
) {
  const result = await db.query<{ id: string }>(
    `insert into categories(id,name,slug,organization_id,parent_category_id,kind,sort_order,show_in_navigation,created_at,updated_at)
     values(gen_random_uuid(),$1,$2,$3,$4,'PRODUCT_TYPE',$5,true,now(),now())
     on conflict (organization_id,slug) where removed_at is null
     do update set name=excluded.name,parent_category_id=excluded.parent_category_id,kind='PRODUCT_TYPE',
       sort_order=excluded.sort_order,show_in_navigation=true,archived_at=null,updated_at=now()
     returning id`,
    [definition.name, definition.slug, organizationId, parentId, definition.order],
  );
  return result.rows[0].id;
}

async function ensurePublication(
  db: PoolClient | Client,
  organizationId: string,
  storeId: string,
  channelId: string,
  categoryIdValue: string,
  order: number,
) {
  await db.query(
    `insert into store_category_publications(id,organization_id,store_id,channel_id,category_id,placements,visible,sort_order,created_at,updated_at)
     values(gen_random_uuid(),$1,$2,$3,$4,'["HOME","CATALOG","NAVIGATION"]'::jsonb,true,$5,now(),now())
     on conflict(store_id,channel_id,category_id) do update set placements=excluded.placements,visible=true,
       sort_order=excluded.sort_order,updated_at=now()`,
    [organizationId, storeId, channelId, categoryIdValue, order],
  );
}

async function ensureNavigationGroup(
  db: PoolClient | Client,
  organizationId: string,
  storeId: string,
  channelId: string,
  key: string,
  name: string,
  order: number,
  categoryIdValue: string,
) {
  const group = await db.query<{ id: string }>(
    `insert into catalogue_groups(id,organization_id,store_id,channel_id,key,name,purpose,placements,active,sort_order,created_at,updated_at)
     values(gen_random_uuid(),$1,$2,$3,$4,$5,'NAVIGATION','["HOME","CATALOG","NAVIGATION"]'::jsonb,true,$6,now(),now())
     on conflict(channel_id,key) do update set name=excluded.name,purpose='NAVIGATION',placements=excluded.placements,
       active=true,sort_order=excluded.sort_order,updated_at=now() returning id`,
    [organizationId, storeId, channelId, key, name, order],
  );
  await db.query(`delete from catalogue_group_categories where group_id=$1`, [group.rows[0].id]);
  await db.query(
    `insert into catalogue_group_categories(organization_id,store_id,group_id,category_id,sort_order,created_at)
     values($1,$2,$3,$4,0,now())`,
    [organizationId, storeId, group.rows[0].id, categoryIdValue],
  );
}

async function snapshot(db: Client, organizationId: string, storeId: string) {
  const counts = await db.query(
    `select c.slug,count(distinct pc.product_id)::int products,
       coalesce(string_agg(distinct ch.key,',' order by ch.key) filter(where scp.visible),'') visible_channels
     from categories c left join product_categories pc on pc.category_id=c.id
     left join store_category_publications scp on scp.category_id=c.id and scp.store_id=$2
     left join catalogue_channels ch on ch.id=scp.channel_id and ch.active
     where c.organization_id=$1 and c.removed_at is null and (
       c.slug=any($3::text[]) or c.slug=any($4::text[]))
     group by c.id,c.slug order by c.slug`,
    [
      organizationId,
      storeId,
      [...tableSlugs],
      Object.values(targets).flatMap((catalogue) => Object.values(catalogue).map((item) => item.slug)),
    ],
  );
  return counts.rows;
}

async function applyPlan(
  db: Client,
  organizationId: string,
  storeId: string,
  decisions: Decision[],
  report: Record<string, unknown>,
) {
  const roots = {
    GENERAL: await categoryId(db, organizationId, GENERAL_ROOT),
    H1: await categoryId(db, organizationId, H1_ROOT),
  };
  const channelRows = await db.query<{ id: string; key: string }>(
    `select id,key from catalogue_channels where store_id=$1 and key=any($2::text[]) and active=true`,
    [storeId, ['mobiliario', 'mobiliario-h1']],
  );
  const channelByKey = new Map(channelRows.rows.map((row) => [row.key, row.id]));
  if (!channelByKey.has('mobiliario') || !channelByKey.has('mobiliario-h1'))
    throw new Error('Faltan los canales mobiliario o mobiliario-h1');

  const categoryIds = new Map<string, string>();
  for (const catalogue of ['GENERAL', 'H1'] as Catalogue[]) {
    for (const target of ['DINING', 'CENTER_AUX', 'DESK'] as Target[]) {
      const definition = targets[catalogue][target];
      categoryIds.set(`${catalogue}:${target}`, await ensureCategory(db, organizationId, definition, roots[catalogue]));
    }
  }

  const sourceRows = await db.query<{ id: string; slug: string }>(
    `select id,slug from categories where organization_id=$1 and slug=any($2::text[]) and removed_at is null`,
    [organizationId, [...tableSlugs]],
  );
  const legacyIdBySlug = new Map(sourceRows.rows.map((row) => [row.slug, row.id]));

  for (const decision of decisions.filter((item) => item.status === 'MIGRATE')) {
    const targetSlug = targets[decision.catalogue!][decision.target!].slug;
    const targetId = categoryIds.get(`${decision.catalogue}:${decision.target}`)!;
    await db.query(`insert into product_categories(product_id,category_id) values($1,$2) on conflict do nothing`, [
      decision.productId,
      targetId,
    ]);
    const removableIds = sourceRows.rows.filter((row) => row.slug !== targetSlug).map((row) => row.id);
    if (removableIds.length) {
      await db.query(`delete from product_categories where product_id=$1 and category_id=any($2::uuid[])`, [
        decision.productId,
        removableIds,
      ]);
    }
    decision.after = decision.before.filter((slug) => !tableSlugs.has(slug) || slug === targetSlug);
    if (!decision.after.includes(targetSlug)) decision.after.push(targetSlug);
    decision.after.sort();
  }

  for (const catalogue of ['GENERAL', 'H1'] as Catalogue[]) {
    const channelKey = catalogue === 'GENERAL' ? 'mobiliario' : 'mobiliario-h1';
    const channelId = channelByKey.get(channelKey)!;
    for (const target of ['DINING', 'CENTER_AUX', 'DESK'] as Target[]) {
      const definition = targets[catalogue][target];
      const id = categoryIds.get(`${catalogue}:${target}`)!;
      await ensurePublication(db, organizationId, storeId, channelId, id, definition.order);
      const key =
        target === 'DINING' ? 'mesas-comedor' : target === 'CENTER_AUX' ? 'mesas-centro-auxiliares' : 'escritorios';
      await ensureNavigationGroup(db, organizationId, storeId, channelId, key, definition.name, definition.order, id);
    }
    await db.query(
      `update catalogue_groups set active=false,updated_at=now()
       where channel_id=$1 and key=any($2::text[])`,
      [channelId, ['mesas', 'mesas-centro']],
    );
  }

  const canonicalIds = new Set(categoryIds.values());
  const legacyIds = sourceRows.rows.filter((row) => !canonicalIds.has(row.id)).map((row) => row.id);
  if (legacyIds.length) {
    await db.query(
      `update store_category_publications set visible=false,placements='[]'::jsonb,updated_at=now()
       where store_id=$1 and category_id=any($2::uuid[])`,
      [storeId, legacyIds],
    );
    await db.query(
      `update categories set show_in_navigation=false,updated_at=now()
       where id=any($1::uuid[])`,
      [legacyIds],
    );
  }
  // The unresolved normal products must remain eligible for the channel's
  // unfiltered product listing, but Mesa is not offered in navigation.
  const unresolvedGeneral = decisions.some(
    (item) =>
      item.status === 'REVIEW' &&
      item.catalogue === 'GENERAL' &&
      has(
        { id: item.productId, name: item.name, manufacturer_code: item.manufacturerCode, slugs: item.before },
        source.generalGeneric,
      ),
  );
  const genericNormalId = legacyIdBySlug.get(source.generalGeneric);
  if (unresolvedGeneral && genericNormalId) {
    await ensurePublication(db, organizationId, storeId, channelByKey.get('mobiliario')!, genericNormalId, 999);
    await db.query(
      `update store_category_publications set placements='[]'::jsonb where store_id=$1 and channel_id=$2 and category_id=$3`,
      [storeId, channelByKey.get('mobiliario'), genericNormalId],
    );
  }

  // Room filters now point to the three independent product types.
  const roomTargets: Record<Catalogue, Array<[string, Target]>> = {
    GENERAL: [
      ['ambiente-comedor', 'DINING'],
      ['ambiente-sala', 'CENTER_AUX'],
      ['ambiente-oficina', 'DESK'],
    ],
    H1: [
      ['ambiente-comedor', 'DINING'],
      ['ambiente-sala', 'CENTER_AUX'],
      ['ambiente-oficina', 'DESK'],
    ],
  };
  for (const catalogue of ['GENERAL', 'H1'] as Catalogue[]) {
    const channelId = channelByKey.get(catalogue === 'GENERAL' ? 'mobiliario' : 'mobiliario-h1')!;
    for (const [groupKey, target] of roomTargets[catalogue]) {
      const group = await db.query<{ id: string }>(
        `select id from catalogue_groups where channel_id=$1 and key=$2 and active=true limit 1`,
        [channelId, groupKey],
      );
      if (!group.rowCount) continue;
      await db.query(`delete from catalogue_group_categories where group_id=$1 and category_id=any($2::uuid[])`, [
        group.rows[0].id,
        sourceRows.rows.map((row) => row.id),
      ]);
      await db.query(
        `insert into catalogue_group_categories(organization_id,store_id,group_id,category_id,sort_order,created_at)
         values($1,$2,$3,$4,0,now()) on conflict(group_id,category_id) do nothing`,
        [organizationId, storeId, group.rows[0].id, categoryIds.get(`${catalogue}:${target}`)],
      );
    }
  }

  const crossContamination = await db.query<{ count: number }>(
    `select count(*)::int count from product_categories pc join categories c on c.id=pc.category_id
     where (pc.product_id=any($1::uuid[]) and c.slug like 'mobiliario-h1%')
        or (pc.product_id=any($2::uuid[]) and c.slug=any($3::text[]))`,
    [
      decisions
        .filter((item) => item.status === 'MIGRATE' && item.catalogue === 'GENERAL')
        .map((item) => item.productId),
      decisions.filter((item) => item.status === 'MIGRATE' && item.catalogue === 'H1').map((item) => item.productId),
      [source.generalGeneric, source.generalDining, source.generalCenter, source.generalAux, source.generalDesk],
    ],
  );
  if (crossContamination.rows[0].count !== 0)
    throw new Error(`La validación detectó ${crossContamination.rows[0].count} asignaciones cruzadas`);
  report.validation = { crossContamination: 0 };
}

async function run() {
  const config = options(process.argv.slice(2));
  const started = new Date();
  await fs.mkdir(config.reportDir, { recursive: true });
  const reportFile = path.join(config.reportDir, `${started.toISOString().replace(/[:.]/g, '-')}-${config.mode}.json`);
  const report: Record<string, any> = {
    mode: config.mode,
    startedAt: started.toISOString(),
    status: 'RUNNING',
    decisions: [],
    errors: [],
  };
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const scope = await db.query<{ organization_id: string; store_id: string }>(
      `select o.id organization_id,s.id store_id from organizations o join stores s on s.organization_id=o.id
       where lower(o.name)=lower($1) and lower(s.name)=lower($2) and o.archived_at is null and s.archived_at is null
         and o.removed_at is null and s.removed_at is null limit 1`,
      [config.organization, config.store],
    );
    if (!scope.rowCount) throw new Error(`No existe el ámbito ${config.organization} / ${config.store}`);
    const { organization_id: organizationId, store_id: storeId } = scope.rows[0];
    const products = await db.query<ProductRow>(
      `select p.id,p.name,p.manufacturer_code,coalesce(array_agg(c.slug order by c.slug) filter(where c.id is not null),'{}') slugs
       from products p left join product_categories pc on pc.product_id=p.id
       left join categories c on c.id=pc.category_id and c.archived_at is null and c.removed_at is null
       where p.organization_id=$1 and p.archived_at is null and p.removed_at is null
       group by p.id,p.name,p.manufacturer_code order by p.name,p.id`,
      [organizationId],
    );
    const decisions = products.rows.map(decide).filter((item): item is Decision => item !== null);
    report.decisions = decisions;
    report.summary = {
      considered: decisions.length,
      migrate: decisions.filter((item) => item.status === 'MIGRATE').length,
      review: decisions.filter((item) => item.status === 'REVIEW').length,
      byTarget: Object.fromEntries(
        (['GENERAL', 'H1'] as Catalogue[]).flatMap((catalogue) =>
          (['DINING', 'CENTER_AUX', 'DESK'] as Target[]).map((target) => [
            `${catalogue}:${target}`,
            decisions.filter(
              (item) => item.status === 'MIGRATE' && item.catalogue === catalogue && item.target === target,
            ).length,
          ]),
        ),
      ),
    };
    report.before = await snapshot(db, organizationId, storeId);
    if (config.mode === 'analyze') {
      report.status = 'ANALYZED';
    } else {
      if (config.mode === 'execute' && config.confirmation !== CONFIRMATION)
        throw new Error(`Use --confirm ${CONFIRMATION}`);
      await db.query('begin');
      await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `designhof-table-reclassification:${organizationId}`,
      ]);
      await applyPlan(db, organizationId, storeId, decisions, report);
      report.after = await snapshot(db, organizationId, storeId);
      if (config.mode === 'plan') {
        await db.query('rollback');
        report.status = 'PLANNED_ROLLED_BACK';
      } else {
        await db.query('commit');
        report.status = 'EXECUTED';
        report.revalidationWarnings = await revalidateStorefronts();
      }
    }
  } catch (error: any) {
    try {
      await db.query('rollback');
    } catch {
      /* connection may not hold a transaction */
    }
    report.status = 'FAILED';
    report.errors.push({ name: error?.name, message: error?.message ?? String(error), stack: error?.stack });
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    await db.end().catch(() => undefined);
    console.log(`Estado: ${report.status}\nReporte: ${reportFile}\n${JSON.stringify(report.summary ?? {}, null, 2)}`);
  }
}

if (require.main === module) void run();
