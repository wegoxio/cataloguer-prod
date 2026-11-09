'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../../lib/api-client';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import { ChevronDown, ChevronUp, GripVertical, RotateCcw, Save } from 'lucide-react';

type Ref = string | { id: string };
type Channel = { id: string; key: string; name: string; active: boolean; isDefault: boolean };
type Group = {
  id: string;
  key: string;
  name: string;
  purpose: 'NAVIGATION' | 'FILTER';
  placements: string[];
  channel: Ref;
  coverProduct?: Ref | null;
  active: boolean;
  sortOrder: number;
};
type Publication = {
  id: string;
  channel: Ref;
  category: Ref;
  visible: boolean;
  placements: string[];
  publicLabel?: string | null;
  sortOrder?: number;
  coverProduct?: Ref | null;
};
type Membership = { groupId: string; categoryId: string };
type Snapshot = { channels: Channel[]; groups: Group[]; publications: Publication[]; memberships: Membership[] };
type Category = { id: string; name: string; slug: string; imageUrl?: string | null };
type Product = { id: string; name: string; categories?: Ref[] };

const idOf = (value: Ref) => typeof value === 'string' ? value : value.id;
const defaultPlacements = ['HOME', 'CATALOG', 'NAVIGATION'];

export function CatalogueNavigationManager({ token, storeId }: { token: string; storeId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [channelId, setChannelId] = useState('');
  const [channelName, setChannelName] = useState('');
  const [channelKey, setChannelKey] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupKey, setGroupKey] = useState('');
  const [groupPurpose, setGroupPurpose] = useState<'NAVIGATION' | 'FILTER'>('NAVIGATION');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [groupCategorySearch, setGroupCategorySearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderDrafts, setOrderDrafts] = useState<Record<string, string[]>>({});
  const [visibilityDrafts, setVisibilityDrafts] = useState<Record<string, string[]>>({});
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const lastDragTargetId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [navigation, firstCategoryPage, firstProductPage] = await Promise.all([
      apiFetch(`/stores/${storeId}/catalogue-navigation`, { token }),
      apiFetch('/categories?page=1&limit=100&sortBy=name&sortDirection=asc', { token }),
      apiFetch('/products?page=1&limit=100&sortBy=name&sortDirection=asc', { token }),
    ]);
    const [remainingCategoryPages, remainingProductPages] = await Promise.all([
      Promise.all(Array.from(
        { length: Math.max(0, Number(firstCategoryPage.totalPages ?? 1) - 1) },
        (_, index) => apiFetch(`/categories?page=${index + 2}&limit=100&sortBy=name&sortDirection=asc`, { token }),
      )),
      Promise.all(Array.from(
        { length: Math.max(0, Number(firstProductPage.totalPages ?? 1) - 1) },
        (_, index) => apiFetch(`/products?page=${index + 2}&limit=100&sortBy=name&sortDirection=asc`, { token }),
      )),
    ]);
    const next = navigation.data as Snapshot;
    setSnapshot(next);
    setCategories([firstCategoryPage, ...remainingCategoryPages].flatMap((page) => page.items ?? []));
    setProducts([firstProductPage, ...remainingProductPages].flatMap((page) => page.items ?? []));
    setChannelId((current) => current || next.channels[0]?.id || '');
  }, [storeId, token]);

  useEffect(() => {
    load().catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudo cargar la navegación'));
  }, [load]);

  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  };

  const publications = useMemo(() => new Map(
    (snapshot?.publications ?? []).filter((item) => idOf(item.channel) === channelId).map((item) => [idOf(item.category), item]),
  ), [snapshot, channelId]);
  const groups = useMemo(
    () => (snapshot?.groups ?? []).filter((item) => idOf(item.channel) === channelId),
    [snapshot, channelId],
  );
  const navigationGroups = useMemo(
    () => groups
      .filter((group) => group.purpose === 'NAVIGATION' && group.active)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)),
    [groups],
  );
  const persistedOrderIds = useMemo(() => navigationGroups.map((group) => group.id), [navigationGroups]);
  const persistedVisibleIds = useMemo(
    () => navigationGroups.filter((group) => group.placements.includes('CATALOG')).map((group) => group.id),
    [navigationGroups],
  );
  const draftOrderIds = orderDrafts[channelId] ?? persistedOrderIds;
  const draftVisibleIds = visibilityDrafts[channelId] ?? persistedVisibleIds;
  const orderedNavigationGroups = useMemo(() => {
    const byId = new Map(navigationGroups.map((group) => [group.id, group]));
    return [
      ...draftOrderIds.map((id) => byId.get(id)).filter((group): group is Group => Boolean(group)),
      ...navigationGroups.filter((group) => !draftOrderIds.includes(group.id)),
    ];
  }, [draftOrderIds, navigationGroups]);
  const orderedGroupIds = orderedNavigationGroups.map((group) => group.id);
  const orderChanged = orderedGroupIds.length === persistedOrderIds.length
    && orderedGroupIds.some((id, index) => id !== persistedOrderIds[index]);
  const visibilityChanged = draftVisibleIds.length !== persistedVisibleIds.length
    || draftVisibleIds.some((id) => !persistedVisibleIds.includes(id));
  const navigationConfigurationChanged = orderChanged || visibilityChanged;
  const memberIds = useMemo(() => new Set(
    (snapshot?.memberships ?? []).filter((item) => item.groupId === selectedGroup).map((item) => item.categoryId),
  ), [snapshot, selectedGroup]);
  const selectedGroupRecord = groups.find((group) => group.id === selectedGroup);
  const publishedGroupCategories = categories
    .filter((category) => publications.get(category.id)?.visible)
    .filter((category) => {
      const query = groupCategorySearch.trim().toLocaleLowerCase();
      return !query || `${category.name} ${category.slug}`.toLocaleLowerCase().includes(query);
    });
  const productsForCategory = (categoryId: string) => products.filter((product) =>
    (product.categories ?? []).some((category) => idOf(category) === categoryId),
  );
  const setDraftOrder = (groupIds: string[]) => {
    setOrderDrafts((current) => ({ ...current, [channelId]: groupIds }));
  };
  const moveNavigationGroup = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= orderedNavigationGroups.length) return;
    const reordered = orderedNavigationGroups.map((group) => group.id);
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setDraftOrder(reordered);
  };
  const moveDraggedGroup = (targetId: string) => {
    if (!draggingGroupId || draggingGroupId === targetId || lastDragTargetId.current === targetId) return;
    lastDragTargetId.current = targetId;
    const reordered = orderedNavigationGroups.map((group) => group.id);
    const from = reordered.indexOf(draggingGroupId);
    const to = reordered.indexOf(targetId);
    if (from < 0 || to < 0) return;
    reordered.splice(to, 0, reordered.splice(from, 1)[0]);
    setDraftOrder(reordered);
  };
  const resetDraftOrder = () => {
    setOrderDrafts((current) => {
      const next = { ...current };
      delete next[channelId];
      return next;
    });
    setVisibilityDrafts((current) => {
      const next = { ...current };
      delete next[channelId];
      return next;
    });
  };
  const toggleGroupVisibility = (groupId: string) => {
    const visible = new Set(draftVisibleIds);
    if (visible.has(groupId)) visible.delete(groupId);
    else visible.add(groupId);
    setVisibilityDrafts((current) => ({ ...current, [channelId]: [...visible] }));
  };
  const saveDraftOrder = () => {
    const groupIds = orderedNavigationGroups.map((group) => group.id);
    void mutate(async () => {
      await apiFetch(
        `/stores/${storeId}/catalogue-navigation/channels/${channelId}/groups/order`,
        { method: 'PUT', token, body: JSON.stringify({ groupIds, visibleGroupIds: draftVisibleIds }) },
      );
      resetDraftOrder();
    });
  };

  if (!snapshot) {
    return <div className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-500">Cargando configuración de tienda…</div>;
  }

  return (
    <section className="space-y-5 rounded-md border border-slate-200 bg-white p-5">
      <div>
        <h3 className="font-semibold text-slate-800">Navegación pública del catálogo</h3>
        <p className="mt-1 text-xs text-slate-500">Canales, categorías y portadas configurables por tienda, sin reglas específicas de ningún cliente.</p>
      </div>
      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <Input label="Nombre del canal" value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="Ej. Catálogo principal" />
        <Input label="Clave estable" value={channelKey} onChange={(event) => setChannelKey(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="catalogo-principal" />
        <div className="self-end">
          <Button disabled={busy || !channelName || !channelKey} onClick={() => mutate(async () => {
            await apiFetch(`/stores/${storeId}/catalogue-navigation/channels`, { method: 'POST', token, body: JSON.stringify({ name: channelName, key: channelKey }) });
            setChannelName('');
            setChannelKey('');
          })}>Crear canal</Button>
        </div>
      </div>

      <label className="block text-xs font-semibold text-slate-600">
        Canal activo
        <select className="mt-1 block w-full rounded border border-slate-300 bg-white p-2 text-sm" value={channelId} onChange={(event) => { setChannelId(event.target.value); setSelectedGroup(''); }}>
          {snapshot.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name} ({channel.key})</option>)}
        </select>
      </label>

      {channelId && <>
        <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-4">
          <h4 className="text-sm font-semibold text-slate-800">Orden de categorias en el sitio</h4>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
              Elige cuáles aparecen en este catálogo y arrástralas hasta obtener el orden deseado. Nada se modifica en DesignHof hasta pulsar Guardar configuración.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={busy || !navigationConfigurationChanged} onClick={resetDraftOrder}>
                <RotateCcw className="h-3.5 w-3.5" /> Descartar
              </Button>
              <Button type="button" size="sm" disabled={busy || !navigationConfigurationChanged} isLoading={busy} onClick={saveDraftOrder}>
                <Save className="h-3.5 w-3.5" /> Guardar configuración
              </Button>
            </div>
          </div>
          {navigationConfigurationChanged && <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">Tienes cambios de navegación sin guardar.</p>}
          <div className="mt-3 space-y-2">
            {navigationGroups.length === 0 ? (
              <p className="rounded border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-500">
                Este canal aun no tiene grupos de navegacion activos.
              </p>
            ) : orderedNavigationGroups.map((group, index) => (
              <div
                key={group.id}
                draggable={!busy}
                onDragStart={(event) => { lastDragTargetId.current = null; setDraggingGroupId(group.id); event.dataTransfer.effectAllowed = 'move'; }}
                onDragEnter={() => moveDraggedGroup(group.id)}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                onDragEnd={() => { lastDragTargetId.current = null; setDraggingGroupId(null); }}
                onDrop={(event) => { event.preventDefault(); lastDragTargetId.current = null; setDraggingGroupId(null); }}
                className={`flex cursor-grab items-center gap-3 rounded-md border px-3 py-2 shadow-sm transition duration-150 active:cursor-grabbing ${draggingGroupId === group.id ? 'scale-[0.99] border-blue-300 bg-blue-50 opacity-60' : draftVisibleIds.includes(group.id) ? 'border-slate-200 bg-white hover:border-blue-200' : 'border-slate-200 bg-slate-50 opacity-60'}`}
              >
                <GripVertical className="h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-700">{group.name}</p>
                  <p className="truncate text-[11px] text-slate-400">{group.key}</p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600" onPointerDown={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={draftVisibleIds.includes(group.id)} disabled={busy} onChange={() => toggleGroupVisibility(group.id)} />
                  Mostrar
                </label>
                <div className="flex gap-1">
                  <button type="button" aria-label={`Subir ${group.name}`} title="Mover arriba" disabled={busy || index === 0} onClick={() => moveNavigationGroup(index, -1)} className="rounded border border-slate-200 p-1.5 text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-30">
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label={`Bajar ${group.name}`} title="Mover abajo" disabled={busy || index === orderedNavigationGroups.length - 1} onClick={() => moveNavigationGroup(index, 1)} className="rounded border border-slate-200 p-1.5 text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-30">
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h4 className="mb-1 text-sm font-semibold text-slate-700">Categorías publicadas</h4>
          <p className="mb-3 text-xs text-slate-500">La imagen propia de la categoría tiene prioridad. El producto de portada se conserva únicamente como respaldo para categorías antiguas sin imagen.</p>
          <div className="grid max-h-[32rem] gap-3 overflow-auto rounded border border-slate-200 p-3 md:grid-cols-2">
            {categories.map((category) => {
              const publication = publications.get(category.id);
              const categoryProducts = productsForCategory(category.id);
              return (
                <div className="space-y-2 rounded border border-slate-100 p-3" key={category.id}>
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-16 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50">
                      {category.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={category.imageUrl} alt="" className="h-full w-full object-contain" />
                      ) : null}
                    </div>
                  <label className="flex items-center gap-2 text-xs font-semibold">
                    <input type="checkbox" checked={Boolean(publication?.visible)} disabled={busy} onChange={(event) => mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/channels/${channelId}/categories/${category.id}`, { method: 'PUT', token, body: JSON.stringify({ visible: event.target.checked, placements: event.target.checked ? defaultPlacements : publication?.placements ?? [] }) }))} />
                    <span>{category.name}</span><span className="font-normal text-slate-400">{category.slug}</span>
                  </label>
                  </div>
                  {publication?.visible && <>
                    <label className="block text-[11px] font-semibold text-slate-500">
                      Respaldo si la categoría no tiene imagen propia
                      <select className="mt-1 block w-full rounded border border-slate-300 bg-white p-2 text-xs" value={publication.coverProduct ? idOf(publication.coverProduct) : ''} disabled={busy} onChange={(event) => mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/channels/${channelId}/categories/${category.id}`, { method: 'PUT', token, body: JSON.stringify({ coverProductId: event.target.value || null }) }))}>
                        <option value="">Automática (producto más reciente)</option>
                        {categoryProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                      </select>
                    </label>
                    <div className="grid grid-cols-[1fr_90px] gap-2">
                      <label className="block text-[11px] font-semibold text-slate-500">
                        Nombre público
                        <input className="mt-1 block w-full rounded border border-slate-300 p-2 text-xs" defaultValue={publication.publicLabel ?? ''} disabled={busy} onBlur={(event) => mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/channels/${channelId}/categories/${category.id}`, { method: 'PUT', token, body: JSON.stringify({ publicLabel: event.target.value.trim() || null }) }))} />
                      </label>
                      <label className="block text-[11px] font-semibold text-slate-500">
                        Orden
                        <input className="mt-1 block w-full rounded border border-slate-300 p-2 text-xs" type="number" min="0" defaultValue={publication.sortOrder ?? 0} disabled={busy} onBlur={(event) => mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/channels/${channelId}/categories/${category.id}`, { method: 'PUT', token, body: JSON.stringify({ sortOrder: Math.max(0, Number(event.target.value) || 0) }) }))} />
                      </label>
                    </div>
                  </>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto]">
          <Input label="Nombre del grupo" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Ej. Sala o Novedades" />
          <Input label="Clave estable" value={groupKey} onChange={(event) => setGroupKey(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="sala" />
          <label className="text-xs font-semibold text-slate-600">Uso<select className="mt-1 block w-full rounded border border-slate-300 bg-white p-2 text-sm" value={groupPurpose} onChange={(event) => setGroupPurpose(event.target.value as 'NAVIGATION' | 'FILTER')}><option value="NAVIGATION">Navegación</option><option value="FILTER">Filtro</option></select></label>
          <div className="self-end"><Button disabled={busy || !groupName || !groupKey} onClick={() => mutate(async () => { await apiFetch(`/stores/${storeId}/catalogue-navigation/channels/${channelId}/groups`, { method: 'POST', token, body: JSON.stringify({ name: groupName, key: groupKey, purpose: groupPurpose, placements: defaultPlacements }) }); setGroupName(''); setGroupKey(''); })}>Crear grupo</Button></div>
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-700">Contenido de grupos</h4>
          <p className="mb-3 rounded-md border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs leading-5 text-slate-600">
            Para que una categoría aparezca en el storefront, primero publícala en el canal activo y después inclúyela en uno de sus grupos de navegación visibles. La categoría padre no controla esta sección.
          </p>
          <select className="mb-3 block w-full rounded border border-slate-300 bg-white p-2 text-sm" value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)}>
            <option value="">Selecciona un grupo</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.purpose}</option>)}
          </select>
          {selectedGroup && <div className="space-y-3">
            <label className="block text-xs font-semibold text-slate-600">
              Imagen de portada del grupo
              <select className="mt-1 block w-full rounded border border-slate-300 bg-white p-2 text-sm" value={selectedGroupRecord?.coverProduct ? idOf(selectedGroupRecord.coverProduct) : ''} disabled={busy} onChange={(event) => mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/groups/${selectedGroup}`, { method: 'PATCH', token, body: JSON.stringify({ coverProductId: event.target.value || null }) }))}>
                <option value="">Automática (producto del grupo)</option>
                {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </select>
            </label>
            <Input
              label="Buscar categoría publicada"
              value={groupCategorySearch}
              onChange={(event) => setGroupCategorySearch(event.target.value)}
              placeholder="Ej. Aparadores / Bar"
            />
            <div className="grid max-h-64 gap-2 overflow-auto rounded border border-slate-200 p-3 md:grid-cols-2 lg:grid-cols-3">
              {publishedGroupCategories.length === 0 && <p className="col-span-full py-3 text-center text-xs text-slate-400">No hay categorías publicadas que coincidan.</p>}
              {publishedGroupCategories.map((category) => <label className="flex items-center gap-2 text-xs" key={category.id}><input type="checkbox" checked={memberIds.has(category.id)} disabled={busy} onChange={(event) => { const ids = new Set(memberIds); event.target.checked ? ids.add(category.id) : ids.delete(category.id); mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/groups/${selectedGroup}/categories`, { method: 'PUT', token, body: JSON.stringify({ categoryIds: [...ids] }) })); }} />{category.name}</label>)}
            </div>
          </div>}
        </div>
      </>}
    </section>
  );
}
