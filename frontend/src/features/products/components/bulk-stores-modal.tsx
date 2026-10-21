'use client';

import React, { useState } from 'react';
import Modal from '../../../components/ui/modal';
import Button from '../../../components/ui/button';
import type { StoreRecord } from '../../../lib/use-website-config';

interface BulkStoresModalProps {
  stores: StoreRecord[];
  onSubmit: (data: { storeIds: string[] }) => Promise<void>;
  onClose: () => void;
}

export default function BulkStoresModal({ stores, onSubmit, onClose }: BulkStoresModalProps) {
  const activeStores = stores.filter((store) => !store.archivedAt);
  const [storeIds, setStoreIds] = useState<string[]>(activeStores.map((store) => store.id));
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setStoreIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <Modal open title="Assign Stores (Bulk)" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          The selected products will be visible in exactly the stores checked below (their current
          assignments are replaced). Selecting none hides them from every website.
        </p>
        <div className="flex flex-col gap-2">
          {activeStores.map((store) => (
            <label
              key={store.id}
              className="inline-flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-slate-700"
            >
              <input
                type="checkbox"
                checked={storeIds.includes(store.id)}
                onChange={() => toggle(store.id)}
                className="rounded text-primary focus:ring-primary"
              />
              {store.name}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            isLoading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit({ storeIds });
              } finally {
                setBusy(false);
              }
            }}
          >
            Assign Stores
          </Button>
        </div>
      </div>
    </Modal>
  );
}
