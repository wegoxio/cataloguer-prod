'use client';

import React from 'react';
import type { ImportType } from '../mapping/mapping-state';

/**
 * The first step of an import: choose what you are importing, and give us the
 * file.
 *
 * This step was missing entirely. The wizard read a source id from the URL and,
 * finding none, showed "Choose a file to import." with nothing to choose a file
 * WITH — a sentence describing an action the screen did not offer. Nothing in
 * the panel created a source, so the safe import path had no beginning.
 *
 * Three things are deliberate here.
 *
 * The file input is a REAL, visible `<input type="file">`. A visually-hidden
 * input behind a styled label is the usual trick and it is where this class of
 * bug hides: it looks right, and it is one CSS change away from being
 * unreachable. The native control is keyboard-operable and announced correctly
 * by screen readers without any of that being our responsibility.
 *
 * Nothing is sent until the operator presses Start. Choosing a file, changing
 * the type, or dropping a file all stay entirely local — so opening this page,
 * or picking a file and changing your mind, creates no import source, no
 * analysis and no row of any kind.
 *
 * Validation happens twice on purpose. Here, so the answer is immediate and in
 * the operator's words; and again on the server, which is the one that decides.
 * The client check is a courtesy, never the guarantee.
 */

/** Formats the parser accepts. Extensions, because that is what people see. */
const ACCEPTED = ['.csv', '.tsv', '.txt', '.xlsx', '.xls'] as const;

/** `MAX_SOURCE_BYTES` in `backend/src/modules/imports/import-limits.ts`. */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

const TYPE_CHOICES: { value: ImportType; label: string; hint: string; needsStore: boolean }[] = [
  { value: 'PRODUCTS', label: 'Products', hint: 'Create or update products in your catalogue.', needsStore: false },
  { value: 'CATEGORIES', label: 'Categories', hint: 'Create or update the category tree.', needsStore: false },
  {
    value: 'HISTORICAL_STORE_SALES',
    label: 'Historical store sales',
    hint: 'Record past sales. Stock is never deducted.',
    needsStore: true,
  },
];

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** The extension check, shared with the tests so both agree on what is accepted. */
export function extensionProblem(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (ACCEPTED.some((ext) => lower.endsWith(ext))) return null;
  return `That file type is not supported. Choose one of: ${ACCEPTED.join(', ')}.`;
}

export function sizeProblem(bytes: number): string | null {
  if (bytes === 0) return 'That file is empty.';
  if (bytes > MAX_SOURCE_BYTES) {
    return `That file is ${formatBytes(bytes)}. The largest we accept is ${formatBytes(MAX_SOURCE_BYTES)}.`;
  }
  return null;
}

export interface SourcePickerClient {
  createUploadTicket(
    token: string,
    body: { fileName: string; contentType: string; maxBytes: number },
  ): Promise<{ objectKey: string; url: string; headers: Record<string, string> }>;
  registerSource(
    token: string,
    body: {
      objectKey: string;
      originalFileName: string;
      sizeBytes: number;
      detectedFormat: string;
    },
  ): Promise<{ id: string }>;
  startAnalysis(token: string, sourceId: string): Promise<{ id: string; status: string }>;
}

export function SourcePicker({
  token,
  importType,
  onImportTypeChange,
  organizationName,
  storeName,
  storeId,
  client,
  onStarted,
  upload,
}: {
  token: string;
  importType: ImportType;
  onImportTypeChange: (next: ImportType) => void;
  organizationName?: string | null;
  storeName?: string | null;
  storeId?: string | null;
  client: SourcePickerClient;
  /** Called once a source exists and its analysis has been asked for. */
  onStarted: (sourceId: string, importType: ImportType) => void;
  /** The signed PUT. Injected so tests never reach the network. */
  upload?: (url: string, headers: Record<string, string>, file: File) => Promise<void>;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const choice = TYPE_CHOICES.find((c) => c.value === importType) ?? TYPE_CHOICES[0];
  const storeMissing = choice.needsStore && !storeId;

  const accept = (candidate: File | null | undefined) => {
    if (!candidate) return;
    const bad = extensionProblem(candidate.name) ?? sizeProblem(candidate.size);
    // A rejected file is NOT kept: leaving it selected invites a second Start
    // press against a file we already refused.
    setProblem(bad);
    setFile(bad ? null : candidate);
  };

  const clear = () => {
    setFile(null);
    setProblem(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const putFile =
    upload ??
    (async (url: string, headers: Record<string, string>, body: File) => {
      // `Content-Length` is a forbidden fetch header — the browser computes it
      // from the body, and passing it explicitly makes the request fail. The
      // signature binds the VALUE, which the browser sets identically.
      const { 'Content-Length': _length, ...sendable } = headers;
      const response = await fetch(url, { method: 'PUT', headers: sendable, body });
      if (!response.ok) {
        throw new Error(`Storage refused the upload (HTTP ${response.status}). Please report this.`);
      }
    });

  const start = async () => {
    if (!file || busy || storeMissing) return;
    setBusy(true);
    setProblem(null);
    try {
      const ticket = await client.createUploadTicket(token, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        maxBytes: file.size,
      });
      try {
        await putFile(ticket.url, ticket.headers, file);
      } catch (cause) {
        // A rejected CORS preflight, a DNS failure and a dropped connection all
        // arrive as the same bare `TypeError: Failed to fetch`. The browser
        // withholds the detail on purpose, so the honest thing is to say what we
        // do know: the request never completed, and trying again will not help.
        // Translating here rather than inside the transport means an injected
        // one is covered too — the message belongs to the operation.
        if (cause instanceof TypeError) {
          throw new Error(
            'The file could not be sent to storage. The upload request did not complete, ' +
              'which usually means storage is refusing requests from this site rather than ' +
              'anything being wrong with your file. Please report this — retrying is unlikely to help.',
          );
        }
        throw cause;
      }
      const source = await client.registerSource(token, {
        objectKey: ticket.objectKey,
        originalFileName: file.name,
        sizeBytes: file.size,
        detectedFormat: (file.name.split('.').pop() ?? '').toLowerCase(),
      });
      await client.startAnalysis(token, source.id);
      onStarted(source.id, importType);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-5 bg-white p-6" data-testid="source-picker">
      <div>
        <h2 className="text-sm font-bold text-slate-800">Start an import</h2>
        <p className="mt-1 text-xs text-slate-600">
          Nothing is changed in your catalogue until you approve a plan.
        </p>
      </div>

      {/* Where this import will land. Someone who cannot see the branch cannot
          tell whether they are about to import into the wrong one. */}
      <p className="text-xs text-slate-500" data-testid="picker-context">
        Importing into <span className="font-semibold text-slate-700">{organizationName || 'your company'}</span>
        {storeName ? (
          <>
            {' · '}
            <span className="font-semibold text-slate-700">{storeName}</span>
          </>
        ) : (
          ' · all branches'
        )}
      </p>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-slate-700">What are you importing?</legend>
        {TYPE_CHOICES.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="radio"
              name="import-type"
              value={option.value}
              checked={importType === option.value}
              disabled={busy}
              onChange={() => onImportTypeChange(option.value)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-slate-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {storeMissing ? (
        <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          Historical store sales belong to one shop. Choose a branch in the sidebar before continuing.
        </p>
      ) : null}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer?.files?.[0]);
        }}
        className={
          'rounded border-2 border-dashed p-4 ' + (dragging ? 'border-sky-500 bg-sky-50' : 'border-slate-300')
        }
        data-testid="drop-zone"
      >
        <label htmlFor="import-file" className="block text-xs font-semibold text-slate-700">
          Choose file
        </label>
        <input
          ref={inputRef}
          id="import-file"
          type="file"
          accept={ACCEPTED.join(',')}
          disabled={busy}
          aria-describedby="import-file-help"
          onChange={(event) => accept(event.target.files?.[0])}
          className="mt-1 block w-full text-xs"
        />
        <p id="import-file-help" className="mt-2 text-[11px] text-slate-500">
          Drag a file here, or use the button above. Accepted: {ACCEPTED.join(', ')}. Largest file:{' '}
          {formatBytes(MAX_SOURCE_BYTES)}.
        </p>
      </div>

      {file ? (
        <div className="flex items-center justify-between gap-3 rounded bg-slate-50 p-2" data-testid="chosen-file">
          <p className="truncate text-xs text-slate-700">
            {file.name} <span className="text-slate-500">({formatBytes(file.size)})</span>
          </p>
          <button
            type="button"
            onClick={clear}
            disabled={busy}
            className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : null}

      {/* `role="alert"` so a screen reader announces the refusal at the moment
          it happens, rather than only on the next focus move. */}
      {problem ? (
        <p role="alert" className="text-xs text-rose-700" data-testid="picker-problem">
          {problem}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void start()}
        disabled={!file || busy || storeMissing}
        className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        data-testid="picker-start"
      >
        {busy ? 'Uploading…' : 'Start import'}
      </button>
      {busy ? (
        <p role="status" className="text-xs text-slate-500">
          Uploading your file and reading it. This can take a moment.
        </p>
      ) : null}
    </div>
  );
}
