import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, flush, cleanupAll } from '../../../../test/render';
import { SourcePicker, extensionProblem, sizeProblem, MAX_SOURCE_BYTES } from './source-picker';
import type { ImportType } from '../mapping/mapping-state';

/**
 * The first step of an import, tested as an ORGANIZATION_MANAGER working in one
 * branch would meet it.
 *
 * The defect these cover was deployed: the wizard said "Choose a file to
 * import." and rendered nothing to choose a file with. No input, hidden or
 * otherwise — the step did not exist, so the safe import path had no beginning
 * while the unsafe legacy one was the only visible way in.
 *
 * The load-bearing property is the last one: opening this screen, picking a
 * file, or changing your mind must create NOTHING on the server.
 */

const ORG = 'TuTienda';
const STORE = 'Tutienda QA – Store B';
const STORE_ID = '8e66b751-c665-4ac3-8d2c-65d6ed69d12a';

function makeClient() {
  return {
    createUploadTicket: vi.fn(async () => ({
      objectKey: 'imports/org/abc.csv',
      url: 'https://example.invalid/signed',
      headers: { 'Content-Type': 'text/csv', 'Content-Length': '20', 'If-None-Match': '*' },
    })),
    registerSource: vi.fn(async () => ({ id: 'source-1' })),
    startAnalysis: vi.fn(async () => ({ id: 'analysis-1', status: 'QUEUED' })),
  };
}

function csv(name = 'p9-acceptance-products.csv', size = 577) {
  const file = new File(['sku,name\nP9ACC-001,Widget Alfa\n'], name, { type: 'text/csv' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** Drives the real <input type="file">, the way a person's file manager does. */
async function choose(input: Element | null, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input?.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

type Overrides = {
  client?: ReturnType<typeof makeClient>;
  onStarted?: (sourceId: string, importType: ImportType) => void;
  upload?: (url: string, headers: Record<string, string>, file: File) => Promise<void>;
  importType?: ImportType;
  onImportTypeChange?: (next: ImportType) => void;
  storeId?: string | null;
};

const mount = async (over: Overrides = {}) => {
  const client = over.client ?? makeClient();
  const onStarted = over.onStarted ?? vi.fn();
  const upload = over.upload ?? vi.fn(async () => undefined);
  const result = await renderComponent(
    <SourcePicker
      token="token"
      importType={over.importType ?? 'PRODUCTS'}
      onImportTypeChange={over.onImportTypeChange ?? vi.fn()}
      organizationName={ORG}
      storeName={STORE}
      storeId={'storeId' in over ? over.storeId ?? null : STORE_ID}
      client={client}
      onStarted={onStarted}
      upload={upload}
    />,
  );
  return { ...result, client, onStarted, upload };
};

afterEach(cleanupAll);

describe('the manager can see and operate the file control', () => {
  it('renders a real, enabled file input', async () => {
    const { container } = await mount();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;

    expect(input).toBeTruthy();
    expect(input?.disabled).toBe(false);
  });

  it('labels it so a screen reader announces a control, not an orphan', async () => {
    const { container } = await mount();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const label = container.querySelector(`label[for="${input.id}"]`);

    expect(input.id).toBeTruthy();
    expect(label?.textContent).toContain('Choose file');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    const help = container.querySelector(`#${input.getAttribute('aria-describedby')}`);
    expect(help?.textContent).toBeTruthy();
  });

  it('states the accepted formats and the effective size limit', async () => {
    const { container } = await mount();
    const text = container.textContent ?? '';

    expect(text).toContain('.csv');
    expect(text).toContain('.xlsx');
    expect(text).toContain('100 MB');
    expect(MAX_SOURCE_BYTES).toBe(100 * 1024 * 1024);
  });

  it('offers drag and drop, with the instruction visible rather than implied', async () => {
    const { container, get } = await mount();
    expect(get('drop-zone')).toBeTruthy();
    expect(container.textContent).toContain('Drag a file here');
  });

  it('shows which company and branch the import will land in', async () => {
    const { get } = await mount();
    expect(get('picker-context').textContent).toContain(ORG);
    expect(get('picker-context').textContent).toContain(STORE);
  });
});

describe('choosing what to import', () => {
  it('offers Products and Historical store sales, and reports the choice', async () => {
    const onImportTypeChange = vi.fn();
    const { container } = await mount({ onImportTypeChange });

    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    const values = radios.map((r) => r.value);
    expect(values).toContain('PRODUCTS');
    expect(values).toContain('HISTORICAL_STORE_SALES');

    await click(radios.find((r) => r.value === 'HISTORICAL_STORE_SALES')!);

    expect(onImportTypeChange).toHaveBeenCalledWith('HISTORICAL_STORE_SALES');
  });

  it('refuses historical sales with no branch chosen, rather than picking one', async () => {
    const { container, get } = await mount({ importType: 'HISTORICAL_STORE_SALES', storeId: null });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('belong to one shop');
    expect((get('picker-start') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('selecting a file', () => {
  it('shows the chosen name and size, with a way to remove it', async () => {
    const { container, get } = await mount();
    await choose(container.querySelector('input[type="file"]'), csv());

    expect(get('chosen-file').textContent).toContain('p9-acceptance-products.csv');
    expect(get('chosen-file').textContent).toContain('577 bytes');

    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!);
    expect(container.querySelector('[data-testid="chosen-file"]')).toBeNull();
  });

  it('enables Start only once a file is chosen', async () => {
    const { container, get } = await mount();
    expect((get('picker-start') as HTMLButtonElement).disabled).toBe(true);

    await choose(container.querySelector('input[type="file"]'), csv());
    expect((get('picker-start') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('validation is announced, not just styled', () => {
  it('refuses an unsupported type and does not keep it', async () => {
    const { container, get } = await mount();
    await choose(container.querySelector('input[type="file"]'), csv('notes.pdf'));

    const problem = get('picker-problem');
    expect(problem.getAttribute('role')).toBe('alert');
    expect(problem.textContent).toContain('not supported');
    expect(container.querySelector('[data-testid="chosen-file"]')).toBeNull();
    expect((get('picker-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a file over the limit, naming both sizes', async () => {
    const { container, get } = await mount();
    await choose(container.querySelector('input[type="file"]'), csv('huge.csv', MAX_SOURCE_BYTES + 1));

    expect(get('picker-problem').textContent).toContain('100 MB');
    expect(container.querySelector('[data-testid="chosen-file"]')).toBeNull();
  });

  it('refuses an empty file', async () => {
    const { container, get } = await mount();
    await choose(container.querySelector('input[type="file"]'), csv('empty.csv', 0));
    expect(get('picker-problem').textContent).toContain('empty');
  });

  it('agrees with the helpers the UI and the tests share', () => {
    expect(extensionProblem('a.csv')).toBeNull();
    expect(extensionProblem('a.xlsx')).toBeNull();
    expect(extensionProblem('a.pdf')).toContain('not supported');
    expect(sizeProblem(10)).toBeNull();
    expect(sizeProblem(MAX_SOURCE_BYTES + 1)).toContain('100 MB');
  });
});

describe('starting the import', () => {
  it('registers the source and asks for its analysis, in that order', async () => {
    const { container, get, client, onStarted, upload } = await mount();
    await choose(container.querySelector('input[type="file"]'), csv());
    await click(get('picker-start'));
    await flush();

    expect(client.createUploadTicket).toHaveBeenCalledWith('token', {
      fileName: 'p9-acceptance-products.csv',
      contentType: 'text/csv',
      maxBytes: 577,
    });
    expect(upload).toHaveBeenCalled();
    expect(client.registerSource).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ objectKey: 'imports/org/abc.csv', sizeBytes: 577, detectedFormat: 'csv' }),
    );
    expect(client.startAnalysis).toHaveBeenCalledWith('token', 'source-1');
    expect(onStarted).toHaveBeenCalledWith('source-1', 'PRODUCTS');
  });

  it('explains a network-level failure instead of showing "Failed to fetch"', async () => {
    // A refused CORS preflight surfaces as a bare TypeError with no status and
    // no body. That is exactly what a real operator saw, and it told them
    // nothing about what to do.
    const upload = async () => {
      throw new TypeError('Failed to fetch');
    };
    const { container, get, client } = await mount({ upload });
    await choose(container.querySelector('input[type="file"]'), csv());
    await click(get('picker-start'));
    await flush();

    const shown = get('picker-problem').textContent ?? '';
    expect(shown).not.toBe('Failed to fetch');
    expect(shown).toContain('could not be sent to storage');
    expect(shown).toContain('report this');
    expect(client.registerSource).not.toHaveBeenCalled();
  });

  it('surfaces a refused upload accessibly instead of pretending it worked', async () => {
    const upload = async () => {
      throw new Error('Upload failed (403)');
    };
    const { container, get, client, onStarted } = await mount({ upload });
    await choose(container.querySelector('input[type="file"]'), csv());
    await click(get('picker-start'));
    await flush();

    expect(get('picker-problem').getAttribute('role')).toBe('alert');
    expect(get('picker-problem').textContent).toContain('403');
    // The source is never registered for a file that did not arrive.
    expect(client.registerSource).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});

describe('nothing is created before an explicit start', () => {
  it('creates nothing merely by opening the screen', async () => {
    const { client } = await mount();

    expect(client.createUploadTicket).not.toHaveBeenCalled();
    expect(client.registerSource).not.toHaveBeenCalled();
    expect(client.startAnalysis).not.toHaveBeenCalled();
  });

  it('creates nothing by choosing a file, changing type, or removing it', async () => {
    const { container, client } = await mount();

    await choose(container.querySelector('input[type="file"]'), csv());
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    await click(radios[1]);
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!);

    expect(client.createUploadTicket).not.toHaveBeenCalled();
    expect(client.registerSource).not.toHaveBeenCalled();
    expect(client.startAnalysis).not.toHaveBeenCalled();
  });

  it('creates nothing when a refused file is chosen', async () => {
    const { container, client } = await mount();
    await choose(container.querySelector('input[type="file"]'), csv('notes.pdf'));

    expect(client.createUploadTicket).not.toHaveBeenCalled();
  });
});
