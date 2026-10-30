'use client';

import Link from 'next/link';
import { ArrowLeft, Globe2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import AccessDenied from '../../../../components/layout/access-denied';
import { CatalogueNavigationManager } from '../../../../features/categories/components/catalogue-navigation-manager';
import { useAuth } from '../../../../lib/auth';
import { canActOnAllowedStore, canManageCatalogue } from '../../../../lib/permissions';
import { useStores } from '../../../../lib/use-website-config';

export default function WebsiteCataloguePage() {
  const params = useParams<{ storeId: string }>();
  const storeId = params.storeId;
  const { accessToken, scope } = useAuth();
  const { stores, loaded } = useStores();
  const store = stores.find((candidate) => candidate.id === storeId);

  if (!loaded) {
    return <div className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-500">Cargando sitio web…</div>;
  }

  if (!store || store.archivedAt || !canActOnAllowedStore(scope, storeId)) {
    return <AccessDenied reason="Este sitio web no existe, está archivado o no pertenece al contexto que tienes seleccionado." />;
  }

  if (!canManageCatalogue(scope) || !accessToken) {
    return <AccessDenied reason="Tu cuenta puede consultar el sitio web, pero no puede cambiar la publicación del catálogo." />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/website" className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" /> Volver a Sitios web / Apps
          </Link>
          <div className="flex items-center gap-2">
            <Globe2 className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold text-slate-800">Catálogo de {store.name}</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Decide qué categorías aparecen en cada canal público y cómo se agrupan en este sitio web.
          </p>
        </div>
        {store.websiteUrl && (
          <a href={store.websiteUrl} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Abrir sitio web
          </a>
        )}
      </div>

      <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-xs leading-5 text-blue-900">
        <strong>Publicar una categoría:</strong> selecciona el canal que consume la página web y marca la categoría en “Categorías publicadas”.
        Para DesignHof, el canal principal es <code className="rounded bg-white/70 px-1">mobiliario</code>.
      </div>

      <CatalogueNavigationManager token={accessToken} storeId={storeId} />
    </div>
  );
}
