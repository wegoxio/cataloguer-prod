'use client';

import React, { useCallback, useRef, useState } from 'react';
import { UploadCloud, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '../../../lib/api-client';
import { optimizeImage, formatBytes } from '../../../lib/image-optimizer';
import { useT } from '../../../lib/i18n';
import { cn } from '../../../lib/cn';
import Button from '../../../components/ui/button';
import { CardPreview, ModePicker } from './image-framing';

interface UploadStatus {
  id: number;
  fileName: string;
  state: 'optimizing' | 'uploading' | 'done' | 'error';
  detail: string;
}

/** A dropped file waiting for its framing choice before it uploads. */
interface PendingFile {
  file: File;
  objectUrl: string;
  name: string;
}

interface ImageUploadZoneProps {
  productId: string;
  accessToken: string;
  /** Sort order to assign to the next uploaded image */
  nextSortOrder: number;
  /** Whether the product already has an active primary image */
  hasPrimary: boolean;
  onUploaded: () => void;
}

let statusId = 0;

export default function ImageUploadZone({
  productId,
  accessToken,
  nextSortOrder,
  hasPrimary,
  onUploaded,
}: ImageUploadZoneProps) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const [statuses, setStatuses] = useState<UploadStatus[]>([]);
  const [busy, setBusy] = useState(false);
  // Files wait here so each gets a framing choice (whole photo vs crop)
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [mode, setMode] = useState<'CONTAIN' | 'COVER'>('CONTAIN');
  const [batchTotal, setBatchTotal] = useState(0);
  // Uploads already confirmed in this batch: the parent's props refresh async,
  // so sortOrder/primary are tracked locally to avoid racing it
  const uploadedInBatch = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateStatus = (id: number, partial: Partial<UploadStatus>) => {
    setStatuses((current) => current.map((s) => (s.id === id ? { ...s, ...partial } : s)));
  };

  // Selecting files queues them for the framing step — nothing uploads yet
  const queueFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((file) => file.type.startsWith('image/'));
      if (images.length === 0 || busy) return;
      setStatuses([]);
      setMode('CONTAIN');
      uploadedInBatch.current = 0;
      setBatchTotal(images.length);
      setPending(images.map((file) => ({ file, objectUrl: URL.createObjectURL(file), name: file.name })));
    },
    [busy],
  );

  const cancelPending = () => {
    pending.forEach((p) => URL.revokeObjectURL(p.objectUrl));
    setPending([]);
    setBatchTotal(0);
  };

  const uploadCurrent = async () => {
    const current = pending[0];
    if (!current || busy) return;
    setBusy(true);
    const id = ++statusId;
    setStatuses((list) => [
      ...list,
      { id, fileName: current.name, state: 'optimizing', detail: `Optimizing ${formatBytes(current.file.size)}...` },
    ]);
    try {
      const optimized = await optimizeImage(current.file);
      updateStatus(id, {
        state: 'uploading',
        detail: `${formatBytes(optimized.originalBytes)} → ${formatBytes(optimized.optimizedBytes)}, uploading...`,
      });

      // 1. Ask the backend for a presigned upload for exactly this many
      // bytes (Content-Length is part of the signature — R2/AWS)
      const ticketResponse = await apiFetch(`/products/${productId}/images/upload-url`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ extension: 'webp', size: optimized.blob.size }),
      });
      const ticket = ticketResponse?.data;
      if (!ticket?.url) {
        throw new Error('Could not get an upload URL');
      }

      // 2. PUT the optimized image directly to object storage with the
      // signed headers (any size/type mismatch invalidates the URL)
      const uploadResponse = await fetch(ticket.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body: optimized.blob,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Storage upload failed (${uploadResponse.status})`);
      }

      // 3. Register the image on the product with the chosen framing
      await apiFetch(`/products/${productId}/images`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          url: ticket.publicUrl,
          altText: current.name.replace(/\.[^.]+$/, ''),
          sortOrder: nextSortOrder + uploadedInBatch.current,
          isPrimary: !hasPrimary && uploadedInBatch.current === 0,
          displayMode: mode,
        }),
      });

      uploadedInBatch.current += 1;
      // The status says what actually happened, warnings included: a photo
      // whose longest edge is small will look soft on a card (deterministic
      // from its pixels — nothing here upscales or "fixes" it), and a photo
      // that needed a harder compression step to fit the byte budget says
      // which one, instead of pretending every upload compressed equally.
      const notes: string[] = [];
      if (optimized.lowResolution) {
        notes.push(t('low resolution ({width}×{height}) — may look soft', {
          width: optimized.width,
          height: optimized.height,
        }));
      }
      if (optimized.quality < 0.82) {
        notes.push(t('compressed harder (quality {quality}) to fit the size limit', { quality: optimized.quality }));
      }
      updateStatus(id, {
        state: 'done',
        detail:
          `${formatBytes(optimized.originalBytes)} → ${formatBytes(optimized.optimizedBytes)} ✓` +
          (notes.length ? ` — ${notes.join('; ')}` : ''),
      });
      onUploaded();
    } catch (err: any) {
      updateStatus(id, { state: 'error', detail: err.message || 'Upload failed' });
    } finally {
      URL.revokeObjectURL(current.objectUrl);
      setPending((queue) => queue.slice(1));
      setMode('CONTAIN');
      setBusy(false);
    }
  };

  const current = pending[0];

  return (
    <div className="space-y-3">
      {current ? (
        /* Framing step: same preview as everywhere else before it uploads */
        <div className="p-4 bg-slate-50 rounded-md border border-slate-200 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-slate-800">
              {t('How it shows on the website')}
              {batchTotal > 1 &&
                ` · ${t('Photo {current} of {total}', {
                  current: batchTotal - pending.length + 1,
                  total: batchTotal,
                })}`}
            </h4>
            <Button size="sm" variant="secondary" onClick={cancelPending} disabled={busy}>
              {t('Cancel')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-4 items-start">
            <CardPreview url={current.objectUrl} mode={mode} name={current.name.replace(/\.[^.]+$/, '')} t={t} />
            <div className="flex-1 min-w-[220px] space-y-3">
              <ModePicker mode={mode} onChange={setMode} t={t} />
              <p className="text-[11px] text-slate-400">
                {t('Whole photo shows everything on a white background. Fill the frame zooms in and crops the edges — best for square photos.')}
              </p>
              <Button size="sm" isLoading={busy} onClick={uploadCurrent}>
                {t('Add to item')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            queueFiles(Array.from(e.dataTransfer.files || []));
          }}
          role="button"
          aria-label={t('Upload images')}
          className={cn(
            'border-2 border-dashed rounded-md p-8 text-center transition-colors',
            busy ? 'cursor-wait opacity-70' : 'cursor-pointer',
            dragging ? 'border-primary bg-primary/5' : 'border-slate-300 bg-slate-50 hover:border-primary/60',
          )}
        >
          <UploadCloud className="h-8 w-8 mx-auto text-slate-400" />
          <p className="text-sm font-semibold text-slate-700 mt-2">
            {busy ? t('Processing images...') : t('Drop images here or click to browse')}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {t('Images are automatically resized and compressed to WebP (max {size}) to keep the website fast.', {
              size: formatBytes(500 * 1024),
            })}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {t('Tip: square photos with the product centered on a light background look best.')}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              queueFiles(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
        </div>
      )}

      {statuses.length > 0 && (
        <ul className="space-y-1.5">
          {statuses.map((status) => (
            <li
              key={status.id}
              className="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded-md px-3 py-2"
            >
              {status.state === 'done' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
              ) : status.state === 'error' ? (
                <AlertCircle className="h-3.5 w-3.5 text-danger shrink-0" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />
              )}
              <span className="font-medium text-slate-700 truncate max-w-[40%]">{status.fileName}</span>
              <span className={cn('flex-1 truncate', status.state === 'error' ? 'text-danger' : 'text-slate-500')}>
                {status.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
