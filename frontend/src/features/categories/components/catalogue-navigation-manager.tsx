'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../lib/api-client';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';

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
type Category = { id: string; name: string; slug: string };
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const memberIds = useMemo(() => new Set(
    (snapshot?.memberships ?? []).filter((item) => item.groupId === selectedGroup).map((item) => item.categoryId),
  ), [snapshot, selectedGroup]);
  const selectedGroupRecord = groups.find((group) => group.id === selectedGroup);
  const productsForCategory = (categoryId: string) => products.filter((product) =>
    (product.categories ?? []).some((category) => idOf(category) === categoryId),
  );

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
        <div>
          <h4 className="mb-1 text-sm font-semibold text-slate-700">Categorías publicadas</h4>
          <p className="mb-3 text-xs text-slate-500">Cada portada reutiliza la imagen principal de un producto publicado. No se duplica el archivo ni se crea una biblioteca independiente.</p>
          <div className="grid max-h-[32rem] gap-3 overflow-auto rounded border border-slate-200 p-3 md:grid-cols-2">
            {categories.map((category) => {
              const publication = publications.get(category.id);
              const categoryProducts = productsForCategory(category.id);
              return (
                <div className="space-y-2 rounded border border-slate-100 p-3" key={category.id}>
                  <label className="flex items-center gap-2 text-xs font-semibold">
                    <input type="checkbox" checked={Boolean(publication?.visible)} disabled={busy} onChange={(event) => mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/channels/${channelId}/categories/${category.id}`, { method: 'PUT', token, body: JSON.stringify({ visible: event.target.checked, placements: event.target.checked ? defaultPlacements : publication?.placements ?? [] }) }))} />
                    <span>{category.name}</span><span className="font-normal text-slate-400">{category.slug}</span>
                  </label>
                  {publication?.visible && <>
                    <label className="block text-[11px] font-semibold text-slate-500">
                      Imagen de portada
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
            <div className="grid max-h-64 gap-2 overflow-auto rounded border border-slate-200 p-3 md:grid-cols-2 lg:grid-cols-3">
              {categories.filter((category) => publications.get(category.id)?.visible).map((category) => <label className="flex items-center gap-2 text-xs" key={category.id}><input type="checkbox" checked={memberIds.has(category.id)} disabled={busy} onChange={(event) => { const ids = new Set(memberIds); event.target.checked ? ids.add(category.id) : ids.delete(category.id); mutate(() => apiFetch(`/stores/${storeId}/catalogue-navigation/groups/${selectedGroup}/categories`, { method: 'PUT', token, body: JSON.stringify({ categoryIds: [...ids] }) })); }} />{category.name}</label>)}
            </div>
          </div>}
        </div>
      </>}
    </section>
  );
}
