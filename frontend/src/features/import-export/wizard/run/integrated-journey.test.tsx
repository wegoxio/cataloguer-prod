import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as path from 'path';
import { createHash } from 'crypto';
import { renderComponent, click, cleanupAll, flush, select } from '../../../../test/render';
import { decodeWizardLocation } from '../mapping/wizard-location';

/**
 * The whole journey, end to end, with nothing scripted above the provider.
 *
 * The fake-server journey beside this proves the wizard behaves. It cannot
 * prove the wizard and the server AGREE, because a scripted server agrees with
 * whatever the frontend expects — the two can drift apart in perfect mutual
 * confidence, and nobody finds out until a customer tries it.
 *
 * So this runs the real thing:
 *
 *  - the real React components, rendered and clicked;
 *  - the real `apiFetch`, over real HTTP;
 *  - the real Nest routes, guards and validation pipe;
 *  - a real disposable PostgreSQL;
 *  - the real runner entrypoint, spawned as a process between steps;
 *  - a deterministic object store ONLY at the provider boundary, so the S3
 *    client, the signing and the presigned URL are all real.
 *
 * Nothing here seeds a source, an analysis or a plan. Every one of them is
 * created by the routes, because a fixture that shortcut the lifecycle would be
 * proving the fixture.
 */

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'backend');
const SERVER = path.join(BACKEND_ROOT, 'dist-integration', 'test', 'integration-server.js');
const RUNNER = path.join(BACKEND_ROOT, 'dist', 'jobs', 'import-runner.main.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const enabled = process.env.ALLOW_PG_DISPOSABLE_TESTS === '1' && Boolean(TEST_DATABASE_URL);
const d = enabled ? describe : describe.skip;

interface Company {
  organizationId: string;
  userId: string;
  email: string;
  warehouseId: string;
  centro: string;
  norte: string;
}

interface Ready {
  apiUrl: string;
  bucket: string;
  storeEndpoint: string;
  databaseName: string;
  accessKeyId: string;
  secretAccessKey: string;
  password: string;
  ours: Company;
  theirs: Company;
}

const CSV = ['sku,nombre,precio,existencias', 'INT-1,Silla de roble,120.50,7', 'INT-2,Mesa baja,80,3'].join('\n');

/**
 * The synthetic file the decisions walk uses.
 *
 * Entirely invented. One row carries positive stock and one carries zero,
 * because "no movement for a zero row" is a different outcome from "no movement
 * because nothing was imported", and only a file containing both can tell them
 * apart. The category column is present so the category decision is genuinely
 * asked rather than skipped.
 */
/**
 * The DRAFT-plan journey's own file.
 *
 * Distinct SKUs on purpose: these tests share one disposable database, and a
 * walk that asserts "this SKU is in exactly one place" fails the moment another
 * walk creates the same SKU somewhere else. The failure looks like a product
 * defect and is not one.
 */
const REVIEW_CSV = [
  'sku,nombre,precio,existencias,categoria',
  'REV-1,Silla de revision,120.50,7,Muebles',
  'REV-2,Mesa de revision,80,0,Muebles',
].join('\n');

const DECISIONS_CSV = [
  'sku,nombre,precio,existencias,categoria',
  'SYN-1,Silla sintetica,120.50,7,Muebles',
  'SYN-2,Mesa sintetica,80,0,Muebles',
].join('\n');

d('the import wizard against a real server (integrated)', () => {
  let server: ChildProcess;
  let ready: Ready;
  let token: string;
  let theirToken: string;

  const childEnv = { ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    // Both artifacts, built the way they ship. The runner is invoked as the
    // The Docker import job invokes it, so the journey exercises the same command an
    // operator would.
    execFileSync('pnpm', ['run', 'build'], { cwd: BACKEND_ROOT, stdio: 'pipe', timeout: 600_000 });
    execFileSync('pnpm', ['run', 'build:integration'], { cwd: BACKEND_ROOT, stdio: 'pipe', timeout: 600_000 });

    ready = await new Promise<Ready>((resolve, reject) => {
      server = spawn(process.execPath, [SERVER], { cwd: BACKEND_ROOT, env: childEnv });
      let buffer = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error('the integration server never became ready')), 240_000);

      server.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // The migrator logs to stdout too, so the ready line is FOUND rather
        // than assumed to be first.
        const line = buffer.split('\n').find((candidate) => candidate.includes('"ready":true'));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line) as Ready);
        }
      });
      // Kept and reported. A harness that dies with its reason discarded costs
      // far more time than the four lines that carry it.
      server.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      server.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the integration server exited early with code ${code}:\n${errors.slice(-4000)}`));
      });
    });

    // `apiFetch` captures the base URL when its module first loads, and the
    // port is only known now — so the variable is set before anything imports
    // it.
    process.env.NEXT_PUBLIC_API_URL = ready.apiUrl;

    token = await signIn(ready.ours.email);
    theirToken = await signIn(ready.theirs.email);
  }, 900_000);

  afterAll(async () => {
    server?.kill('SIGTERM');
    // Give the harness a moment to drop its disposable database rather than
    // leaving one behind on every run.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    cleanupAll();
  });

  /* -------------------------------------------------------------- utilities */

  const signIn = async (email: string): Promise<string> => {
    const response = await fetch(`${ready.apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: ready.password }),
    });
    if (!response.ok) throw new Error(`login failed for ${email}: ${response.status}`);
    const body = (await response.json()) as { data: { accessToken: string } };
    return body.data.accessToken;
  };

  const api = async (
    method: string,
    endpoint: string,
    body?: unknown,
    as: string = token,
  ): Promise<{ status: number; data: never }> => {
    const response = await fetch(`${ready.apiUrl}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${as}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as { data?: never }) : {};
    return { status: response.status, data: (parsed.data ?? parsed) as never };
  };

  /**
   * Run the real runner entrypoint, exactly as the scheduled job will.
   *
   * Same command, same arguments, same environment shape — a database, an
   * import bucket, its own credentials and the privacy affirmation the storage
   * service refuses to start without. If this passes and the deployed job
   * fails, the difference is the provider, not the program.
   */
  const drain = (mode: 'analysis' | 'execution'): { code: number; fact: Record<string, unknown> } => {
    const read = (raw: string): Record<string, unknown> => {
      const line = raw
        .split('\n')
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.startsWith('{') && candidate.includes('"job"'))
        .pop();
      return line ? (JSON.parse(line) as Record<string, unknown>) : {};
    };

    try {
      const stdout = execFileSync(process.execPath, [RUNNER, `--mode=${mode}`, '--max-items=5'], {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        env: {
          ...childEnv,
          DATABASE_URL: disposableDatabaseUrl(),
          IMPORT_SOURCE_BUCKET: ready.bucket,
          IMPORT_SOURCE_BUCKET_PRIVATE: 'true',
          IMPORT_SOURCE_ACCESS_KEY_ID: ready.accessKeyId,
          IMPORT_SOURCE_SECRET_ACCESS_KEY: ready.secretAccessKey,
          IMPORT_SOURCE_ENDPOINT: ready.storeEndpoint,
          STORAGE_REGION: 'auto',
          JWT_ACCESS_SECRET: 'integration-journey-access-secret',
          JWT_REFRESH_SECRET: 'integration-journey-refresh-secret',
        },
        stdio: 'pipe',
        timeout: 240_000,
      });
      return { code: 0, fact: read(stdout) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { code: failure.status ?? 1, fact: read(failure.stdout ?? '') };
    }
  };

  /**
   * The disposable database the harness created.
   *
   * Rebuilt from this process's own `TEST_DATABASE_URL` plus the name the
   * harness printed. The harness deliberately prints a NAME rather than a
   * connection string: a URL carrying credentials has no business in a log,
   * and the caller already holds the credentials — they are how it reached the
   * harness in the first place.
   */
  /**
   * How many analyses this source actually has, read from the database.
   *
   * Asked of the table rather than of an endpoint: an endpoint returning one id
   * is exactly what a duplicate-inserting bug would also do, having returned the
   * newest of two.
   *
   * Run as a short node process from the BACKEND root, the same way the runner
   * is spawned, because `pg` is a backend dependency and this is a frontend
   * test. Nothing about the query needs the application.
   */
  /**
   * Ask the disposable database a question directly.
   *
   * Asked of the tables rather than of an endpoint: an endpoint reporting one
   * listing is exactly what a duplicate-inserting bug would also report, having
   * returned the newest of two. Facts about rows are checked against rows.
   *
   * Run as a short node process from the BACKEND root, the same way the runner
   * is spawned, because `pg` is a backend dependency and this is a frontend
   * test. Nothing about the query needs the application.
   */
  const query = <T,>(sql: string, params: unknown[] = []): T[] => {
    const program = [
      "const { Client } = require('pg');",
      "const c = new Client({ connectionString: process.argv[1] });",
      "c.connect()",
      "  .then(() => c.query(process.argv[2], JSON.parse(process.argv[3])))",
      "  .then((r) => { console.log(JSON.stringify(r.rows)); return c.end(); })",
      "  .catch((e) => { console.error(e.message); process.exit(1); });",
    ].join('\n');
    const out = execFileSync(
      process.execPath,
      ['-e', program, disposableDatabaseUrl(), sql, JSON.stringify(params)],
      { cwd: BACKEND_ROOT, encoding: 'utf8' },
    );
    return JSON.parse(out.trim()) as T[];
  };

  const analysisCount = (sourceId: string): number =>
    Number(
      query<{ n: number }>('select count(*)::int as n from import_analyses where source_id = $1', [sourceId])[0].n,
    );

  const disposableDatabaseUrl = (): string => {
    const url = new URL(TEST_DATABASE_URL as string);
    url.pathname = `/${ready.databaseName}`;
    return url.toString();
  };

  /**
   * A storage that behaves exactly as a browser's does.
   *
   * Handed to two successive renders, which is what makes the reload in this
   * file a real one: the second wizard learns about the first only through
   * these bytes, the same way a second page load does.
   */
  const makeStorage = () => {
    const map = new Map<string, string>();
    return {
      map,
      get length() {
        return map.size;
      },
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  };

  /** Upload a file the way the browser does, then register it. */
  const uploadAndRegister = async (csv: string, fileName: string): Promise<{ sourceId: string }> => {
    const ticket = await api('POST', '/import/lifecycle/sources/ticket', {
      fileName,
      contentType: 'text/csv',
      maxBytes: 1024 * 1024,
    });
    const { url, headers, objectKey } = ticket.data as unknown as {
      url: string;
      headers: Record<string, string>;
      objectKey: string;
    };
    const upload = await fetch(url, { method: 'PUT', headers, body: csv });
    if (!upload.ok) throw new Error(`upload failed: ${upload.status}`);

    const source = await api('POST', '/import/lifecycle/sources', {
      objectKey,
      originalFileName: fileName,
      sizeBytes: Buffer.byteLength(csv),
      contentHash: createHash('sha256').update(Buffer.from(csv, 'utf8')).digest('hex'),
      detectedFormat: 'CSV_OR_TEXT',
    });
    return { sourceId: (source.data as unknown as { id: string }).id };
  };

  /**
   * Count every call the browser makes, by what it asks for.
   *
   * A screen-level assertion can pass while the page quietly re-reads the file,
   * builds a second plan, or asks for a preview nobody needed. Those are the
   * faults that reached production three times, and none of them are visible in
   * the DOM. So the journeys below assert the exact number of each request.
   */
  const countCalls = () => {
    const counts: Record<string, number> = {
      listSources: 0, getSource: 0, startAnalysis: 0, getAnalysis: 0,
      preview: 0, getPlan: 0, planLifecycle: 0, createPlan: 0, approve: 0, execute: 0,
      // The terminal reads. Untracked until now, which is part of why an inert
      // View results could ship: no journey could even ask whether pressing it
      // sent anything.
      rowResults: 0, reportSummary: 0, cancel: 0, resume: 0,
    };
    const real = globalThis.fetch;
    const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (method === 'GET' && /\/import\/lifecycle\/sources(\?|$)/.test(path)) counts.listSources++;
      else if (method === 'GET' && /\/import\/lifecycle\/sources\/[^/]+$/.test(path)) counts.getSource++;
      else if (method === 'POST' && /\/analysis$/.test(path)) counts.startAnalysis++;
      else if (method === 'GET' && /\/import\/lifecycle\/analyses\//.test(path)) counts.getAnalysis++;
      else if (method === 'POST' && /\/import\/wizard\/preview$/.test(path)) counts.preview++;
      else if (method === 'GET' && /\/plans\/[^/]+\/lifecycle$/.test(path)) counts.planLifecycle++;
      else if (method === 'GET' && /\/import\/lifecycle\/plans\/[^/]+$/.test(path)) counts.getPlan++;
      else if (method === 'POST' && /\/import\/lifecycle\/plans$/.test(path)) counts.createPlan++;
      else if (method === 'POST' && /\/approve$/.test(path)) counts.approve++;
      else if (method === 'POST' && /\/execute$/.test(path)) counts.execute++;
      else if (method === 'GET' && /\/executions\/[^/]+\/rows/.test(path)) counts.rowResults++;
      else if (method === 'GET' && /\/executions\/[^/]+\/report$/.test(path)) counts.reportSummary++;
      else if (method === 'POST' && /\/cancel$/.test(path)) counts.cancel++;
      else if (method === 'POST' && /\/resume$/.test(path)) counts.resume++;
      return real(input as never, init);
    };
    globalThis.fetch = spy as never;
    return { counts, stop: () => { globalThis.fetch = real; } };
  };

  /** The href a rendered action actually points at — never one the test built. */
  const destinationOf = (element: Element | null): { search: string; location: ReturnType<typeof decodeWizardLocation> } => {
    const href = element?.getAttribute('href') ?? '';
    const search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    return { search, location: decodeWizardLocation(search) };
  };

  /* ------------------------------------------- resuming a plan that already exists */

  /**
   * The path manual acceptance failed on, end to end.
   *
   * A draft said "Ready to review", Resume opened the mapping editor, and the
   * editor waited for a preview it never asked for while the finished plan sat
   * unread on the server. Every earlier test passed: they checked screens, not
   * the route between them, and they counted nothing.
   *
   * So this one starts at the listing, follows the href the listing RENDERS,
   * and counts every request the browser makes.
   */
  it('resumes a DRAFT plan into review, reading it rather than remapping it', async () => {
    const { sourceId } = await uploadAndRegister(REVIEW_CSV, 'draft-review.csv');

    // A real analysis, read by the real runner.
    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });
    const analysis = await api('GET', `/import/lifecycle/sources/${sourceId}`);
    expect((analysis.data as unknown as { status: string }).status).toBe('AVAILABLE');

    // A real DRAFT plan, built through the real route.
    const created = await api('POST', '/import/lifecycle/plans', {
      sourceId,
      importType: 'PRODUCTS',
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
          { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
          { columnIndex: 2, header: 'precio', field: 'price', reviewed: true },
          { columnIndex: 3, header: 'existencias', field: 'stock', reviewed: true },
          { columnIndex: 4, header: 'categoria', field: 'categoryPaths', reviewed: true },
        ],
      },
      // Five rows, so the stored summary says five — the same shape as the
      // Package A plan this journey stands in for.
      sample: {
        headers: ['sku', 'nombre', 'precio', 'existencias', 'categoria'],
        rows: [
          ['SYN-1', 'Silla', '120.50', '7', 'Muebles'],
          ['SYN-2', 'Mesa', '80', '0', 'Muebles'],
          ['SYN-3', 'Lampara', '35', '3', 'Iluminacion'],
          ['SYN-4', 'Alfombra', '90', '2', 'Textil'],
          ['SYN-5', 'Estante', '150', '1', 'Muebles'],
        ],
        firstRowNumber: 2,
      },
      columnTypes: ['TEXT', 'TEXT', 'NUMBER', 'NUMBER', 'TEXT'],
      storeId: ready.ours.centro,
      relationships: {
        stores: { storeIds: [ready.ours.centro] },
        inventory: { defaultLocationId: ready.ours.warehouseId },
        categories: { columnIndex: 4, createMissing: true, pathSeparator: '>' },
      },
    });
    const planId = (created.data as unknown as { id: string }).id;
    expect(planId).toBeTruthy();

    const { DraftImports } = await import('../../draft-imports');
    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    /* ---- the landing surface, over real HTTP ---------------------------- */
    const listing = countCalls();
    const drafts = await renderComponent(<DraftImports token={token} storage={null} />);
    await settle(drafts, 40);

    const row = drafts.get(`draft-${sourceId}`);
    expect(row.textContent ?? '').toContain('draft-review.csv');
    expect(drafts.get(`draft-stage-${sourceId}`).textContent).toBe('Ready to review');
    expect(listing.counts.listSources).toBe(1);

    /* ---- the destination the LISTING built, not one this test wrote ------ */
    const resume = drafts.find(`draft-resume-${sourceId}`);
    expect(resume).toBeTruthy();
    const destination = destinationOf(resume);
    expect(destination.location.sourceId).toBe(sourceId);
    // The whole correction: a row that says "Ready to review" carries the plan.
    expect(destination.location.planId).toBe(planId);
    listing.stop();
    cleanupAll();

    /* ---- follow it ------------------------------------------------------ */
    const review = countCalls();
    const wizard = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={destination.location}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={null}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(wizard, 60);

    expect(wizard.find('plan-review')).toBeTruthy();
    expect(wizard.find('mapping-editor')).toBeNull();
    expect(wizard.text()).not.toContain('Waiting for the preview');
    expect(wizard.get('plan-review-rows').textContent).toBe('5');
    expect(wizard.get('plan-review-columns').textContent).toBe('5');

    // The decisions come back from the SERVER's plan, not from this browser.
    const summary = wizard.get('relationship-summary').textContent ?? '';
    expect(summary.length).toBeGreaterThan(0);

    // Approval is offered and untouched.
    expect(wizard.find('plan-review-approve')).toBeTruthy();

    /* ---- and nothing was re-derived ------------------------------------- */
    expect(review.counts.planLifecycle).toBe(1);
    expect(review.counts.getPlan).toBe(1);
    // The faults that reached production, counted rather than described.
    expect(review.counts.startAnalysis).toBe(0);
    expect(review.counts.preview).toBe(0);
    expect(review.counts.createPlan).toBe(0);
    expect(review.counts.approve).toBe(0);
    expect(review.counts.execute).toBe(0);
    review.stop();

    /* ---- APPROVE, for real ---------------------------------------------- */
    // The button was on screen, wired, and dead: `approve()` read the run
    // machine's plan, plan review held its own, and the handler returned at
    // its first line. Nothing was ever asserted about pressing it.
    const approving = countCalls();
    await click(wizard.get('plan-review-approve'));
    await settle(wizard, 60);

    expect(approving.counts.approve).toBe(1);
    // The approved state and its Start control are one surface now, on both
    // entry paths. Asserted by the route-independent attribute so this journey
    // cannot pass while the other route has lost the control.
    expect(wizard.container.querySelector('[data-plan-action="START"]')).toBeTruthy();
    expect(wizard.get('plan-surface-detail').textContent ?? '').not.toBe('');
    // The next step is offered, and Approve is gone so it cannot be pressed twice.
    expect(wizard.find('plan-review-start')).toBeTruthy();
    expect(wizard.find('plan-review-approve')).toBeNull();
    approving.stop();

    // Exactly one approval row, against THIS plan, and still no execution:
    // approving is not running.
    const approvals = query<{ id: string; plan_id: string; consumed_at: string | null }>(
      'select id, plan_id, consumed_at from import_approvals where plan_id = $1',
      [planId],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].plan_id).toBe(planId);
    expect(approvals[0].consumed_at).toBeNull();
    expect(
      query<{ n: number }>('select count(*)::int as n from import_executions where plan_id = $1', [planId])[0].n,
    ).toBe(0);

    // The proof authorises a write across the whole catalogue. It is never
    // rendered.
    const proofRow = query<{ proof_hash: string }>('select proof_hash from import_approvals where plan_id = $1', [planId]);
    expect(wizard.text()).not.toContain(proofRow[0].proof_hash);

    /* ---- START, and watch the recovery furniture go ---------------------- */
    // The transition, against a real server and a real runner. Both ends of it
    // were tested before and both passed; the defect lived in the moment
    // between them, where the proof is cleared the instant a run starts while
    // the lifecycle still said `mayExecute` — so a panel appeared claiming
    // nothing had been written, at the exact moment something was.
    const starting = countCalls();
    await click(wizard.get('plan-review-start'));
    await settle(wizard, 60);

    expect(starting.counts.execute).toBe(1);
    // The lifecycle is re-read at once; the stale answer is the whole cause.
    expect(starting.counts.planLifecycle).toBeGreaterThanOrEqual(1);
    starting.stop();

    expect(wizard.get('plan-surface').getAttribute('data-surface-kind') ?? '').toMatch(/IN_FLIGHT|TERMINAL/);
    // Absent here for TWO independent reasons — the run outranks it, and the
    // refetched lifecycle says EXECUTING so `mayExecute` is false anyway. That
    // redundancy is why this journey cannot tell the precedence rule from the
    // refetch; the STALE-lifecycle case, where only precedence saves the
    // screen, is covered in `plan-review.test.tsx` and mutation-checked there.
    expect(wizard.find('plan-review-proof-lost')).toBeNull();
    expect(wizard.find('plan-review-withdraw')).toBeNull();
    expect(wizard.find('plan-review-approve')).toBeNull();
    expect(wizard.find('plan-review-start')).toBeNull();
    expect(wizard.text()).not.toContain('Nothing has been written');

    // Exactly one execution, and the approval spent exactly once.
    const runs = query<{ id: string; status: string }>(
      'select id, status from import_executions where plan_id = $1',
      [planId],
    );
    expect(runs).toHaveLength(1);

    /* ---- let the real runner finish it ----------------------------------- */
    expect(drain('execution')).toMatchObject({ code: 0, fact: { executionsRun: 1 } });
    await settle(wizard, 60);

    const settled = query<{ status: string }>('select status from import_executions where plan_id = $1', [planId]);
    expect(settled[0].status).toBe('COMPLETED');

    // Still exactly one — finishing must not mint a second.
    expect(
      query<{ n: number }>('select count(*)::int as n from import_executions where plan_id = $1', [planId])[0].n,
    ).toBe(1);
    // And the approval was consumed once, by that run.
    const spent = query<{ consumed_at: string | null }>(
      'select consumed_at from import_approvals where plan_id = $1 and revoked_at is null',
      [planId],
    );
    expect(spent).toHaveLength(1);
    expect(spent[0].consumed_at).not.toBeNull();

    // The rows really landed.
    // Two, because the file has two data rows. The stored plan's summary says
    // five because the SAMPLE sent when it was built had five — the plan
    // records what was reviewed, the run records what was in the file.
    const written = query<{ n: number }>(
      'select count(*)::int as n from import_row_results where execution_id = $1',
      [runs[0].id],
    );
    expect(written[0].n).toBe(2);

    /* ---- and it survives a reload with no browser storage at all --------- */
    cleanupAll();
    const reloaded = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={destination.location}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={null}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(reloaded, 60);
    expect(reloaded.find('plan-review')).toBeTruthy();
    expect(reloaded.find('restore-offer')).toBeNull();

    /* ---- one of everything, and no more ---------------------------------- */
    // One approval from the one press, one run from the one start, and the
    // reload in between minted neither.
    expect(
      query<{ n: number }>('select count(*)::int as n from import_approvals where plan_id = $1', [planId])[0].n,
    ).toBe(1);
    expect(
      query<{ n: number }>('select count(*)::int as n from import_executions where plan_id = $1', [planId])[0].n,
    ).toBe(1);
    expect(query<{ n: number }>('select count(*)::int as n from import_analyses where source_id = $1', [sourceId])[0].n).toBe(1);
    expect(query<{ n: number }>('select count(*)::int as n from import_plans where source_id = $1', [sourceId])[0].n).toBe(1);
  }, 900_000);

  /**
   * The exact state plan `bcdb9687…` is in, end to end.
   *
   * Approved on the server, zero executions, and the one-time proof held by
   * nobody — because the approval was minted over HTTP and this browser never
   * saw it. That is what a refreshed or closed tab leaves behind, and it used
   * to be a dead end twice over: the listing called it "Importing" and offered
   * no link, and the wizard route it could not be reached from had no recovery
   * panel anyway.
   *
   * The destination is READ from the rendered listing, never constructed here.
   * A test that builds its own URL proves the wizard works when handed a good
   * one; it proves nothing about whether anybody can get there.
   */
  it('recovers an approved plan whose proof nobody holds, from the listing', async () => {
    const { sourceId } = await uploadAndRegister(REVIEW_CSV, 'package-b-recovery.csv');

    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });

    const created = await api('POST', '/import/lifecycle/plans', {
      sourceId,
      importType: 'PRODUCTS',
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
          { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
        ],
      },
      sample: {
        headers: ['sku', 'nombre'],
        rows: [['SYN-1', 'Silla']],
        firstRowNumber: 2,
      },
      columnTypes: ['TEXT', 'TEXT'],
      storeId: ready.ours.centro,
      relationships: { stores: { storeIds: [ready.ours.centro] } },
    });
    const planId = (created.data as unknown as { id: string }).id;

    // Approved over HTTP. The proof is returned to THIS call and dropped on the
    // floor — no browser ever holds it, exactly as after a refresh.
    const approval = await api('POST', `/import/lifecycle/plans/${planId}/approve`);
    expect((approval.data as unknown as { proof: string }).proof).toBeTruthy();

    // The preconditions, read from the server rather than assumed.
    const life = (await api('GET', `/import/lifecycle/plans/${planId}/lifecycle`))
      .data as unknown as { state: string; mayExecute: boolean; execution: unknown };
    expect(life.state).toBe('APPROVED');
    expect(life.mayExecute).toBe(true);
    expect(life.execution).toBeNull();

    const { DraftImports } = await import('../../draft-imports');
    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    /* ---- the listing must offer a way in ------------------------------- */
    const drafts = await renderComponent(<DraftImports token={token} storage={null} />);
    await settle(drafts, 40);

    expect(drafts.get(`draft-stage-${sourceId}`).textContent).toBe('Approved, not started');
    const resume = drafts.find(`draft-resume-${sourceId}`);
    // The link is the whole point: without it this plan is unreachable.
    expect(resume).toBeTruthy();

    const destination = destinationOf(resume);
    expect(destination.location.sourceId).toBe(sourceId);
    expect(destination.location.planId).toBe(planId);
    cleanupAll();

    /* ---- follow it, and find a way out --------------------------------- */
    const wizard = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={destination.location}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={null}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(wizard, 60);

    // The shared surface, saying plainly what happened and offering the one
    // action that can resolve it.
    expect(wizard.get('plan-surface-headline').textContent ?? '').toContain(
      'one-time authorization is unavailable',
    );
    expect(wizard.container.querySelector('[data-plan-action="WITHDRAW"]')).toBeTruthy();

    // And nothing that could only fail or could double-write.
    expect(wizard.container.querySelector('[data-plan-action="START"]')).toBeNull();
    expect(wizard.container.querySelector('[data-plan-action="APPROVE"]')).toBeNull();

    /* ---- withdrawing actually returns it to approvable ------------------ */
    await click(wizard.get('plan-review-withdraw'));
    await settle(wizard, 60);

    const after = (await api('GET', `/import/lifecycle/plans/${planId}/lifecycle`))
      .data as unknown as { state: string; mayApprove: boolean };
    expect(after.state).toBe('PREPARED');
    expect(after.mayApprove).toBe(true);

    // Still nothing written, which is the promise the recovery panel makes.
    const executions = query<{ n: string }>(
      `select count(*)::text as n from import_executions where plan_id = '${planId}'`,
    );
    expect(executions[0]?.n).toBe('0');
    // Explicit, because this journey uploads, analyses, approves, renders two
    // surfaces and withdraws against a real server. It must pass under the
    // ordinary `vitest run src` gate too, not only under the long-timeout
    // integrated script — a test that runs in one gate and times out in the
    // other is a test somebody will learn to ignore.
  }, 120_000);

  /**
   * The Package B path, end to end, including what happens AFTER it finishes.
   *
   * The journeys before this one stopped at the terminal headline. That is
   * exactly how an inert View results shipped: the projection offers the
   * action, the button renders, the request goes out and returns 200 — and the
   * route it was pressed on has nowhere to put the answer. `RowTable` and the
   * report live in `RunPanel`, and `PlanReview` renders neither.
   *
   * So this asserts the RESULT, not the offer: a real request, and rows and a
   * report visible on the screen the button was pressed on.
   */
  it('shows row results and the report where View results was pressed', async () => {
    const { sourceId } = await uploadAndRegister(REVIEW_CSV, 'terminal-actions.csv');
    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });

    const created = await api('POST', '/import/lifecycle/plans', {
      sourceId,
      importType: 'PRODUCTS',
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
          { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
          // A third mapped column, so this journey's plan hash is its OWN.
          // Plans are content-addressed on purpose: identical bytes with
          // identical decisions resolve to the same plan, and two journeys
          // that agreed on both were silently sharing one.
          { columnIndex: 2, header: 'precio', field: 'price', reviewed: true },
        ],
      },
      sample: {
        headers: ['sku', 'nombre', 'precio'],
        rows: [['SYN-1', 'Silla', '120.50']],
        firstRowNumber: 2,
      },
      columnTypes: ['TEXT', 'TEXT', 'NUMBER'],
      storeId: ready.ours.centro,
      relationships: { stores: { storeIds: [ready.ours.centro] } },
    });
    const planId = (created.data as unknown as { id: string }).id;

    // Approved out of band, so the proof is lost — the Package B shape.
    await api('POST', `/import/lifecycle/plans/${planId}/approve`);

    const { DraftImports } = await import('../../draft-imports');
    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    const drafts = await renderComponent(<DraftImports token={token} storage={null} />);
    await settle(drafts, 40);
    const destination = destinationOf(drafts.find(`draft-resume-${sourceId}`));
    cleanupAll();

    const wizard = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={destination.location}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={null}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(wizard, 60);

    /* ---- withdraw -> reapprove -> execute, all from this one screen ------ */
    await click(wizard.get('plan-review-withdraw'));
    await settle(wizard, 60);
    await click(wizard.get('plan-review-approve'));
    await settle(wizard, 60);
    await click(wizard.get('plan-review-start'));
    await settle(wizard, 60);

    // At least one, not exactly one: the runner drains whatever is queued, and
    // other journeys in this file share it.
    const ran = drain('execution');
    expect(ran.code).toBe(0);
    expect(Number((ran.fact as { executionsRun: number }).executionsRun)).toBeGreaterThanOrEqual(1);
    await settle(wizard, 60);

    // Terminal, and the results action is offered.
    const results = wizard.container.querySelector('[data-plan-action="VIEW_RESULTS"]') as HTMLElement | null;
    expect(results).not.toBeNull();

    /* ---- press it, and require an ANSWER on screen ----------------------- */
    const before = countCalls();
    await click(results);
    await settle(wizard, 60);

    // EXACTLY one read per press. The Package B logs show five pairs of rows
    // and report inside three seconds, every one answering 200 onto a screen
    // with nowhere to put them.
    expect(before.counts.rowResults).toBe(1);
    expect(before.counts.reportSummary).toBe(1);

    // ...and the answer is VISIBLE on the screen the button was pressed on.
    expect(wizard.find('row-results')).not.toBeNull();
    const table = wizard.get('row-results').textContent ?? '';
    // The outcome word, the per-row EFFECTS and the detail — not merely that a
    // table exists. The four effect columns are the whole reason this table was
    // built: a run that created products and listed none of them read as a
    // success until each thing a row touches said what it did.
    // Whether the row was added or updated depends on what earlier journeys in
    // this file left behind, and that is not what this test is about. What must
    // be visible is a stated outcome and the four EFFECT columns — the columns
    // that exist because a run which created products and listed none of them
    // read as a success until each thing a row touches said what it did.
    expect(table).toMatch(/Added|Updated/);
    expect(table).toContain('created in centro (unpublished)');
    expect(table).toMatch(/not requested/);
    expect(table).toMatch(/Created as a draft|Matched on/);
    // The report and its download, on the same screen.
    expect(wizard.find('run-report')).not.toBeNull();
    expect(wizard.find('download-report')).not.toBeNull();
    expect(wizard.get('download-report').getAttribute('href') ?? '').toContain('/report');

    /* ---- and the question is not asked twice ---------------------------- */
    // Answered, so the control is replaced by its answer rather than left
    // standing to be pressed again.
    expect(wizard.container.querySelector('[data-plan-action="VIEW_RESULTS"]')).toBeNull();
    await settle(wizard, 20);
    expect(before.counts.rowResults).toBe(1);
    expect(before.counts.reportSummary).toBe(1);
    before.stop();
  }, 180_000);

  /**
   * A finished import, opened in a browser that knows nothing about it.
   *
   * No proof, no machine execution, no saved mapping — only the URL and the
   * server. This is what a person sees the day after, and it is where the
   * silent returns lived: the action was offered from the lifecycle and the
   * handler looked for an execution id the machine had never been given.
   */
  it('opens a finished import from the rendered listing and shows what it did', async () => {
    const { sourceId } = await uploadAndRegister(REVIEW_CSV, 'terminal-reopen.csv');
    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });

    const created = await api('POST', '/import/lifecycle/plans', {
      sourceId,
      importType: 'PRODUCTS',
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
          { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
          // Distinct again, for the same content-addressing reason.
          { columnIndex: 4, header: 'categoria', field: 'categoryPaths', reviewed: true },
        ],
      },
      sample: {
        headers: ['sku', 'nombre', 'categoria'],
        rows: [['SYN-9', 'Banco', 'Muebles']],
        firstRowNumber: 2,
      },
      columnTypes: ['TEXT', 'TEXT', 'TEXT'],
      storeId: ready.ours.centro,
      relationships: { stores: { storeIds: [ready.ours.centro] } },
    });
    const planId = (created.data as unknown as { id: string }).id;

    // Approved AND run entirely over HTTP. No browser is involved at any point.
    const approval = await api('POST', `/import/lifecycle/plans/${planId}/approve`);
    await api('POST', `/import/lifecycle/plans/${planId}/execute`, {
      proof: (approval.data as unknown as { proof: string }).proof,
    });
    const ranReopen = drain('execution');
    expect(ranReopen.code).toBe(0);
    expect(Number((ranReopen.fact as { executionsRun: number }).executionsRun)).toBeGreaterThanOrEqual(1);

    const { DraftImports } = await import('../../draft-imports');
    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    /* ---- start where a PERSON starts: the Import activity listing -------- */
    const drafts = await renderComponent(<DraftImports token={token} storage={null} />);
    await settle(drafts, 40);

    expect(drafts.get(`draft-stage-${sourceId}`).textContent).toBe('Imported');
    // The history summary, on the row itself: what the retired history page
    // promised — rows in, and what happened to each of them — read from the
    // execution's own counters over real HTTP.
    expect(drafts.get(`draft-summary-${sourceId}`).textContent ?? '').toMatch(/added|updated|left unchanged/);
    const openLink = drafts.find(`draft-resume-${sourceId}`);
    // The whole defect: a finished import with no way in. This link did not
    // exist, and the journey that "covered" this path built its own URL.
    expect(openLink).toBeTruthy();
    expect(openLink!.textContent?.trim()).toBe('View results');

    // Read from the DOM, never constructed here.
    const destination = destinationOf(openLink);
    expect(destination.location.sourceId).toBe(sourceId);
    expect(destination.location.planId).toBe(planId);
    cleanupAll();

    const reading = countCalls();
    const wizard = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        // The destination the LISTING built.
        location={destination.location}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        // No saved mapping, no proof: this browser has never seen this import.
        storage={null}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(wizard, 60);

    // Terminal, from the server alone.
    expect(wizard.get('plan-surface-headline').textContent ?? '').toMatch(/has run/i);

    const view = wizard.container.querySelector('[data-plan-action="VIEW_RESULTS"]') as HTMLElement | null;
    expect(view).not.toBeNull();
    await click(view);
    await settle(wizard, 60);

    // A real request, made with an id only the lifecycle could supply.
    expect(reading.counts.rowResults).toBe(1);
    expect(reading.counts.reportSummary).toBe(1);
    reading.stop();

    expect(wizard.find('row-results')).not.toBeNull();
    const reopened = wizard.get('row-results').textContent ?? '';
    expect(reopened).toMatch(/Added|Updated/);
    expect(reopened).toContain('created in centro (unpublished)');
    expect(wizard.find('run-report')).not.toBeNull();
    expect(wizard.find('download-report')).not.toBeNull();
    // No error, and no lingering offer to ask the same question again.
    expect(wizard.find('run-error')).toBeNull();
    expect(wizard.container.querySelector('[data-plan-action="VIEW_RESULTS"]')).toBeNull();
  }, 180_000);

  it('tells another company nothing about that plan, not even that it exists', async () => {
    const { sourceId } = await uploadAndRegister(DECISIONS_CSV, 'private-draft.csv');
    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    drain('analysis');
    const created = await api('POST', '/import/lifecycle/plans', {
      sourceId,
      importType: 'PRODUCTS',
      mapping: { sheet: 'main', headerRow: 1, columns: [{ columnIndex: 0, header: 'sku', field: 'sku', reviewed: true }] },
      sample: { headers: ['sku'], rows: [['SYN-1']], firstRowNumber: 2 },
      columnTypes: ['TEXT'],
    });
    const planId = (created.data as unknown as { id: string }).id;

    // The other company's token, against the real routes.
    const theirs = await api('GET', `/import/lifecycle/plans/${planId}`, undefined, theirToken);
    const theirLifecycle = await api('GET', `/import/lifecycle/plans/${planId}/lifecycle`, undefined, theirToken);
    expect(theirs.status).toBe(404);
    expect(theirLifecycle.status).toBe(404);
    // NOT 403: that a plan exists in a company they cannot see is itself a
    // disclosure, and the two answers must be indistinguishable.
    expect(JSON.stringify(theirs.data)).not.toContain(planId);

    // And it is absent from their listing entirely.
    const theirList = await api('GET', '/import/lifecycle/sources', undefined, theirToken);
    expect(JSON.stringify(theirList.data)).not.toContain(sourceId);
  }, 900_000);

  /* ------------------------------------- resuming a mapping draft, and its preview */

  /**
   * A source with a reading and no plan, resumed from the listing.
   *
   * The second half of the production failure: after Restore saved work the
   * editor asked for no preview at all, because the request was keyed on a
   * mapping that had not changed. Counting is the only way to see that — the
   * screen looked like it was loading something.
   */
  it('resumes a mapping draft, restores it, and asks for exactly one preview', async () => {
    const storage = makeStorage();
    const { sourceId } = await uploadAndRegister(DECISIONS_CSV, 'mapping-draft.csv');
    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });

    const { DraftImports } = await import('../../draft-imports');
    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    const open = (location: ReturnType<typeof decodeWizardLocation>) => (
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={location}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={storage}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />
    );

    /* ---- map it, decide everything, then leave --------------------------- */
    const first = await renderComponent(open({ sourceId, importType: 'PRODUCTS' }));
    await settle(first, 60);
    await select(first.get('column-3').querySelector('select'), 'stock');
    await select(first.get('column-4').querySelector('select'), 'categoryPaths');
    await settle(first, 40);
    await click(first.get(`destination-${ready.ours.warehouseId}`) ?? first.get('section-stock').querySelector('[data-testid^="destination-"]'));
    await click(first.get('list-here'));
    await click(first.get('categories-accept'));
    await settle(first, 40);
    expect(storage.map.size).toBe(1);
    cleanupAll();

    /* ---- find it in the listing ----------------------------------------- */
    const listing = countCalls();
    const drafts = await renderComponent(<DraftImports token={token} storage={storage} />);
    await settle(drafts, 40);
    expect(drafts.get(`draft-stage-${sourceId}`).textContent).toBe('Mapping in progress');
    // Its decisions ARE on this machine, so no "saved elsewhere" note.
    expect(drafts.find(`draft-local-missing-${sourceId}`)).toBeNull();
    const destination = destinationOf(drafts.find(`draft-resume-${sourceId}`));
    expect(destination.location.sourceId).toBe(sourceId);
    // A mapping row carries no plan — the stage and the route agree.
    expect(destination.location.planId).toBeUndefined();
    listing.stop();
    cleanupAll();

    /* ---- follow it, and restore ----------------------------------------- */
    const resumed = countCalls();
    const wizard = await renderComponent(open(destination.location));
    await settle(wizard, 60);
    expect(wizard.find('restore-offer')).toBeTruthy();

    const previewsBefore = resumed.counts.preview;
    await click(wizard.get('restore-continue'));
    await settle(wizard, 80);

    // Exactly one, even though the restored mapping serialises identically to
    // what was already on screen. Nought was the production failure; more than
    // one would be a loop.
    expect(resumed.counts.preview - previewsBefore).toBe(1);
    expect(wizard.text()).not.toContain('Waiting for the preview');

    // The file was NOT read again.
    expect(resumed.counts.startAnalysis).toBeLessThanOrEqual(1);
    expect(analysisCount(sourceId)).toBe(1);

    // And the decisions came back.
    expect((wizard.get('list-here') as HTMLInputElement).checked).toBe(true);
    expect((wizard.get('categories-accept') as HTMLInputElement).checked).toBe(true);
    expect(wizard.find('relationships-outstanding')).toBeNull();

    // Only now is the plan reachable, and no plan was built along the way.
    expect(wizard.get('prepare-import').hasAttribute('disabled')).toBe(false);
    expect(resumed.counts.createPlan).toBe(0);
    resumed.stop();

    expect(query<{ n: number }>('select count(*)::int as n from import_plans where source_id = $1', [sourceId])[0].n).toBe(0);
  }, 900_000);

  /**
   * A preview that never answers.
   *
   * "Waiting for the preview." had no exit because nothing was in flight to
   * fail. Now something always is, and it always ends — with a sentence and a
   * button rather than a spinner.
   */
  it('ends a hanging preview with an error and a Retry that works', async () => {
    const { sourceId } = await uploadAndRegister(DECISIONS_CSV, 'preview-fault.csv');
    await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    drain('analysis');

    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    // A deterministic fault in front of the REAL server: the first preview
    // never answers, everything else passes through untouched.
    const real = globalThis.fetch;
    let hangFirstPreview = true;
    let previewCalls = 0;
    const late: { resolve: (() => void) | null } = { resolve: null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/import\/wizard\/preview$/.test(url) && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        previewCalls += 1;
        if (hangFirstPreview) {
          hangFirstPreview = false;
          // Hangs until the test lets it answer — LATE, after Retry.
          return new Promise((resolve) => {
            late.resolve = () => void real(input as never, init).then(resolve);
          });
        }
      }
      return real(input as never, init);
    }) as never;

    try {
      const wizard = await renderComponent(
        <Phase9ImportWizard
          availability="ALLOWED"
          token={token}
          location={{ sourceId, importType: 'PRODUCTS' }}
          storeId={ready.ours.centro}
          sourceStatus="AVAILABLE"
          storage={null}
          pollIntervalMs={250}
          // Shorter than production's 20s so the suite does not wait; the
          // BOUND is what is under test, not its size.
          previewTimeoutMs={1500}
          lifecycle={lifecycleService}
        />,
      );
      await settle(wizard, 60);

      // Past the bound.
      await new Promise((resolve) => setTimeout(resolve, 2200));
      await settle(wizard, 40);

      expect(wizard.find('preview-failed')).toBeTruthy();
      expect(wizard.get('preview-failed-reason').textContent ?? '').toMatch(/could not check your mapping in time/i);
      expect(wizard.find('preview-retry')).toBeTruthy();
      // Terminal: it is not still asking.
      const afterTimeout = previewCalls;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(previewCalls).toBe(afterTimeout);

      // The abandoned request answers now. It must change nothing.
      late.resolve?.();
      await settle(wizard, 40);
      expect(wizard.find('preview-failed')).toBeTruthy();

      // Retry: exactly one new request, and it succeeds.
      await click(wizard.get('preview-retry'));
      await new Promise((resolve) => setTimeout(resolve, 900));
      await settle(wizard, 60);
      expect(previewCalls).toBe(afterTimeout + 1);
      expect(wizard.find('preview-failed')).toBeNull();
      expect(wizard.text()).not.toContain('Waiting for the preview');
    } finally {
      globalThis.fetch = real;
    }
  }, 900_000);

  /* -------------------------------------------- the decisions a mapping cannot make */

  /**
   * The three questions a column mapping cannot answer, asked and answered.
   *
   * A mapping says a column holds stock. It cannot say WHICH of a company's
   * locations the units belong to, whether the products should be listed in a
   * shop, or whether a category named in the file may be created. Those are
   * custody, publication and taxonomy decisions, and the import refuses to
   * guess any of them.
   *
   * This walk exists because the refusal used to be silent. The button said
   * "Answer the questions above" beside a form whose every visible control was
   * answered, and there was no way to discover what was actually missing. So
   * every assertion here is about being TOLD: each requirement named, each one
   * pointing at the control that satisfies it, and the plan unreachable until
   * all three are settled.
   *
   * It runs first in this file deliberately. One import runs at a time per
   * company — correctly — and a walk placed after the cancellation test would
   * be refused by an execution that test left behind.
   */
  it('requires each decision by name, then builds and runs the plan', async () => {
    const { sourceId } = await uploadAndRegister(DECISIONS_CSV, 'decisions.csv');

    const started = await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(started.status).toBe(201);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });

    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    const storage = makeStorage();
    const wizard = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={{ sourceId, importType: 'PRODUCTS' }}
        // Scoped to one shop, which is what makes the listing question askable
        // at all: an import with no scoped shop has nothing to list into, and
        // the wizard correctly does not ask.
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={storage}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(wizard, 60);

    // The same source is not read twice. Proven here as well as in the journey
    // above because this walk reaches the wizard by a different route, and a
    // reuse that held only on one path would not be reuse.
    expect(analysisCount(sourceId)).toBe(1);

    /* ---- the mapping that raises all three questions ---------------------- */
    await select(wizard.get('column-3').querySelector('select'), 'stock');
    await select(wizard.get('column-4').querySelector('select'), 'categoryPaths');
    await settle(wizard, 40);

    /* ---- every refusal names its cause ------------------------------------ */
    const outstanding = wizard.get('relationships-outstanding').textContent ?? '';
    // Named, not counted. "3 decisions remaining" is the sentence this replaced:
    // true, and no help at all to somebody trying to find the third one.
    expect(outstanding).toMatch(/stock/i);
    expect(outstanding).toMatch(/shop|store/i);
    expect(outstanding).toMatch(/categor/i);

    // And the plan is unreachable until they are settled. The outstanding list
    // stands WHERE the button would be, rather than beside a button that does
    // nothing: the dead end this replaced was a live-looking control and a
    // sentence that would not say what it wanted.
    expect(wizard.find('prepare-import')).toBeNull();

    /* ---- each requirement points at its own control ----------------------- */
    // Pointing is the whole repair: the original dead end was a true refusal
    // with no route to the control that would lift it.
    for (const id of ['stock', 'stores', 'categories']) {
      await click(wizard.get(`goto-${id}`));
      await settle(wizard, 4);
      expect(document.activeElement?.id).toBe(`relationship-section-${id}`);
    }

    /* ---- choosing IS confirming ------------------------------------------ */
    // No second "yes I meant it" tick anywhere in these three sections. Asking
    // twice is what taught people the first control had not counted.
    const stock = wizard.get('section-stock');
    const destination = stock.querySelector('[data-testid^="destination-"]') as HTMLElement | null;
    expect(destination).toBeTruthy();
    const chosenLocationId = (destination?.getAttribute('data-testid') ?? '').replace('destination-', '');
    expect(chosenLocationId).not.toBe('');
    await click(destination);
    await settle(wizard, 10);
    // One answered is not three. The gate does not open early, and the list
    // shrinks to name only what is genuinely left.
    expect(wizard.find('prepare-import')).toBeNull();
    expect(wizard.get('relationships-outstanding').textContent ?? '').not.toMatch(/physical stock is held/i);

    await click(wizard.get('list-here'));
    await settle(wizard, 10);
    expect(wizard.find('prepare-import')).toBeNull();

    await click(wizard.get('categories-accept'));
    await settle(wizard, 20);

    // Settled means settled: nothing is left asking.
    expect(wizard.find('relationships-outstanding')).toBeNull();

    for (const section of ['section-stock', 'section-stores', 'section-categories']) {
      const html = wizard.get(section).innerHTML;
      expect(html).not.toMatch(/type="checkbox"[^>]*confirm|confirm[^>]*type="checkbox"/i);
    }

    /* ---- and it all survives closing the tab ------------------------------ */
    // A real reload against the real server: the component is destroyed and a
    // new one is built, knowing only what is in storage. This is where the work
    // used to disappear — the new wizard's autosave ran before its own read,
    // and wrote an empty set of decisions over the saved ones while the offer
    // to restore them was still on screen.
    cleanupAll();
    const reloaded = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={{ sourceId, importType: 'PRODUCTS' }}
        storeId={ready.ours.centro}
        sourceStatus="AVAILABLE"
        storage={storage}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );
    await settle(reloaded, 60);

    expect(reloaded.find('restore-offer')).toBeTruthy();
    await click(reloaded.get('restore-continue'));
    await settle(reloaded, 40);

    // Every decision, still made — and the file was not read a second time to
    // get them back.
    expect((reloaded.get(`destination-${chosenLocationId}`) as HTMLInputElement).checked).toBe(true);
    expect((reloaded.get('list-here') as HTMLInputElement).checked).toBe(true);
    expect((reloaded.get('categories-accept') as HTMLInputElement).checked).toBe(true);
    expect(reloaded.find('relationships-outstanding')).toBeNull();
    expect(analysisCount(sourceId)).toBe(1);

    /* ---- and only now is the plan reachable ------------------------------- */
    expect(reloaded.get('prepare-import').hasAttribute('disabled')).toBe(false);


    // The summary states each decision back in the operator's words, so what
    // was chosen is legible at the moment of approval rather than only after.
    const summary = reloaded.get('relationship-summary').textContent ?? '';
    expect(summary.length).toBeGreaterThan(0);

    await click(reloaded.get('prepare-import'));
    await settle(wizard, 30);
    expect(reloaded.get('plan-identity').textContent ?? '').not.toBe('');

    /* ---- the decisions reach the stored plan, not just the screen --------- */
    const planRow = query<{ id: string; store_id: string | null; decisions: Record<string, unknown> }>(
      'select id, store_id, decisions from import_plans where source_id = $1',
      [sourceId],
    );
    expect(planRow).toHaveLength(1);

    // Carried, not re-derived at execution from defaults — which is how a run
    // once listed six products in no shop while reporting them all created.
    const decisions = JSON.stringify(planRow[0].decisions ?? {});
    expect(decisions).toContain('inventory');
    expect(decisions).toContain('categories');

    // The shop the operator chose, named in the stored plan by its own id.
    // An approved store set is indivisible: it applies exactly as approved or
    // the run refuses, so the plan must carry the set rather than a hint that
    // execution could reinterpret.
    expect(decisions).toContain(ready.ours.centro);
    expect(planRow[0].store_id).toBe(ready.ours.centro);

    /* ---- executed against a real database --------------------------------- */
    await click(reloaded.get('approve-import'));
    await settle(wizard, 20);
    await click(reloaded.get('start-import'));
    await settle(wizard, 20);

    expect(drain('execution')).toMatchObject({ code: 0, fact: { executionsRun: 1 } });
    await settle(wizard, 40);
    expect(reloaded.get('plan-surface-headline').textContent ?? '').toMatch(/has run/i);

    /* ---- and the catalogue really changed, checked against the rows ------- */
    const products = query<{ sku: string }>(
      "select sku from products where sku in ('SYN-1','SYN-2') order by sku",
    );
    expect(products.map((p) => p.sku)).toEqual(['SYN-1', 'SYN-2']);

    // The declared zero moved nothing. Asserted separately from the positive
    // row because "no movement because the file said zero" and "no movement
    // because nothing was imported" are the same empty table otherwise.
    const balances = query<{ sku: string; quantity: number; location_id: string }>(
      `select p.sku, b.quantity, b.location_id
         from inventory_balances b join products p on p.id = b.product_id
        where p.sku in ('SYN-1','SYN-2') order by p.sku`,
    );
    const bySku = new Map(balances.map((b) => [b.sku, Number(b.quantity)]));
    expect(bySku.get('SYN-1')).toBe(7);
    expect(bySku.get('SYN-2') ?? 0).toBe(0);

    // Held in ONE place — the one that was chosen. Stock spread across two
    // locations totalling seven would satisfy a sum and still be wrong, so the
    // count of locations is asserted rather than the total.
    const placements = balances.filter((b) => Number(b.quantity) > 0);
    expect(placements).toHaveLength(1);
    expect(placements[0].location_id).toBe(chosenLocationId);

    // Reload persistence is NOT asserted here. Reopening the wizard against a
    // real browser storage loses the saved decisions on the deployed build:
    // the save effect is guarded on a mapping that is empty for the first
    // frames after a remount, so it writes `{}` over the saved answers before
    // the restore offer can be accepted. That is a production defect, it is
    // recorded as one, and encoding it as an expectation here would freeze it.
  }, 900_000);

  /* ------------------------------------------------------------ the journey */

  it('walks a person from an uploaded file to an imported catalogue', async () => {
    /* ---- upload registration, through the real signed ticket ------------- */
    const ticket = await api('POST', '/import/lifecycle/sources/ticket', {
      fileName: 'export.csv',
      contentType: 'text/csv',
      maxBytes: 1024 * 1024,
    });
    expect(ticket.status).toBe(201);
    const { url, headers, objectKey } = ticket.data as unknown as {
      url: string;
      headers: Record<string, string>;
      objectKey: string;
    };

    // The browser's own upload: a PUT to the presigned URL, with exactly the
    // headers that were signed into it.
    const upload = await fetch(url, { method: 'PUT', headers, body: CSV });
    expect(upload.ok).toBe(true);

    const source = await api('POST', '/import/lifecycle/sources', {
      objectKey,
      originalFileName: 'export.csv',
      sizeBytes: Buffer.byteLength(CSV),
      contentHash: createHash('sha256').update(Buffer.from(CSV, 'utf8')).digest('hex'),
      detectedFormat: 'CSV_OR_TEXT',
    });
    expect(source.status).toBe(201);
    const sourceId = (source.data as unknown as { id: string }).id;

    /* ---- analysis, completed by the real runner entrypoint ---------------- */
    const started = await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(started.status).toBe(201);
    const analysisId = (started.data as unknown as { id: string }).id;

    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 1 } });

    const analysis = await api('GET', `/import/lifecycle/analyses/${analysisId}`);
    const analysed = analysis.data as unknown as {
      status: string;
      tables: { headers: string[]; sample: { headers: string[]; rows: string[][]; firstRowNumber: number } };
      proposals: { columnIndex: number; header: string; field: string | null; reasons: string[] }[];
    };
    expect(analysed.status).toBe('COMPLETED');
    expect(analysed.tables.headers).toEqual(['sku', 'nombre', 'precio', 'existencias']);

    /* ---- the real editor, driven by a person ----------------------------- */
    const { Phase9ImportWizard } = await import('../phase9/import-wizard');
    const { lifecycleService } = await import('../api/lifecycle.service');

    const wizard = await renderComponent(
      <Phase9ImportWizard
        availability="ALLOWED"
        token={token}
        location={{ sourceId, importType: 'PRODUCTS' }}
        sourceStatus="AVAILABLE"
        storage={null}
        pollIntervalMs={250}
        lifecycle={lifecycleService}
      />,
    );

    // Reopening a source does NOT analyse it again.
    //
    // A source is immutable - the object is written create-only and its content
    // hash is fixed at registration - so bytes already read are not read a
    // second time. Before that was true, every reload of the wizard queued a
    // fresh analysis of the same file and the operator watched a queue they had
    // just rejoined the back of; five analyses of one 577-byte file were
    // produced that way before anybody noticed.
    //
    // So the drain finds nothing to do, and that IS the assertion. The wizard
    // still fills, because it is handed the completed analysis rather than a
    // new one.
    await settle(wizard, 4);
    expect(drain('analysis')).toMatchObject({ code: 0, fact: { analysesRun: 0 } });
    await settle(wizard, 60);

    // The SAME analysis, not merely 'an' analysis: a second row carrying the
    // same content would satisfy a count and still be the defect.
    const reopened = await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`);
    expect(reopened.status).toBe(201);
    expect((reopened.data as unknown as { id: string }).id).toBe(analysisId);
    expect((reopened.data as unknown as { status: string }).status).toBe('COMPLETED');
    expect(analysisCount(sourceId)).toBe(1);

    // The editor fills from the SERVER's proposals rather than from anything
    // this test supplied.
    expect(wizard.text()).toContain('existencias');

    // A person decides the one column the analysis could not place. Here they
    // choose NOT to import it: this file's stock says nothing about which shop
    // holds the units, and custody is a decision the import refuses to make on
    // anybody's behalf. Mapping it without naming a destination would — quite
    // correctly — refuse every row, which the inventory audit proves in its own
    // right; what this journey follows is the ordinary path.
    await select(wizard.get('column-3').querySelector('select'), '');
    await settle(wizard, 20);

    /* ---- plan, approval and execution, through the components ------------ */
    const prepare = wizard.find('prepare-import');
    expect(prepare).toBeTruthy();
    expect(prepare?.hasAttribute('disabled')).toBe(false);

    await click(prepare);
    await settle(wizard, 20);
    expect(wizard.get('plan-identity').textContent ?? '').not.toBe('');

    await click(wizard.get('approve-import'));
    await settle(wizard, 20);
    // The proof is server-issued and single-use, and it is never on screen.
    // The approval is real and server-issued: the panel shows its notice and
    // offers to start. That the PROOF itself never reaches the screen is a
    // property with a precise oracle — the exact minted string — and is proven
    // where that oracle exists, in `run-machine.test.ts` and the fake-server
    // journey. Asserting it here by pattern would be guesswork against text
    // that runs words together.
    expect(wizard.get('approval-notice').textContent ?? '').not.toBe('');
    expect(wizard.find('start-import')).toBeTruthy();

    await click(wizard.get('start-import'));
    await settle(wizard, 20);

    // Queued, not run: the routes enqueue and the job drains.
    expect(drain('execution')).toMatchObject({ code: 0, fact: { executionsRun: 1 } });
    await settle(wizard, 30);

    /* ---- status, rows and report ----------------------------------------- */
    expect(wizard.get('run-status').textContent ?? '').toMatch(/finished/i);

    await click(wizard.get('show-results'));
    await settle(wizard, 20);
    const rowText = wizard.get('row-results').textContent ?? '';
    expect(rowText).toContain('Added');

    // And the catalogue really changed, checked through the API rather than
    // through the screen that just claimed it.
    const products = await api('GET', '/products?limit=50');
    const names = JSON.stringify(products.data);
    expect(names).toContain('Silla de roble');
    expect(names).toContain('Mesa baja');
  }, 900_000);

  /* ------------------------------------ cancellation and interrupted retry */

  it('honours a cancellation request and resumes an interrupted run', async () => {
    const csv = ['sku,nombre', ...Array.from({ length: 6 }, (_, i) => `RESUME-${i + 1},Producto ${i + 1}`)].join('\n');
    const { sourceId } = await uploadAndRegister(csv, 'resume.csv');

    const plan = await api('POST', '/import/lifecycle/plans', {
      sourceId,
      importType: 'PRODUCTS',
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
          { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
        ],
      },
      sample: { headers: ['sku', 'nombre'], rows: [['RESUME-1', 'Producto 1']], firstRowNumber: 2 },
      columnTypes: ['TEXT', 'TEXT'],
    });
    const planId = (plan.data as unknown as { id: string }).id;

    const approval = await api('POST', `/import/lifecycle/plans/${planId}/approve`);
    const execution = await api('POST', `/import/lifecycle/plans/${planId}/execute`, {
      proof: (approval.data as unknown as { proof: string }).proof,
    });
    const executionId = (execution.data as unknown as { id: string }).id;

    // Cancellation is a REQUEST, made before the job picks the run up. The
    // status must say so without claiming the run has stopped.
    const cancelled = await api('POST', `/import/lifecycle/executions/${executionId}/cancel`);
    expect(cancelled.status).toBe(201);
    // "Will stop", not "has stopped", and it says what happens to the work
    // already done — the two things somebody cancelling actually needs.
    const notice = (cancelled.data as unknown as { notice: string }).notice;
    expect(notice).toMatch(/next safe point/i);
    expect(notice).toMatch(/already imported is kept/i);

    const beforeRunning = await api('GET', `/import/lifecycle/executions/${executionId}`);
    expect((beforeRunning.data as unknown as { cancelRequested: boolean }).cancelRequested).toBe(true);

    // The job runs it, sees the request, and stops at a safe boundary.
    drain('execution');

    const settled = await api('GET', `/import/lifecycle/executions/${executionId}`);
    const status = settled.data as unknown as { status: string; resumable: boolean; rows: { created: number } };
    expect(['CANCELLED', 'COMPLETED', 'PARTIALLY_COMPLETED']).toContain(status.status);

    // Whatever it committed is durable and accounted for: running the job again
    // must not write those rows a second time.
    const rowsAfterFirst = await api('GET', `/import/lifecycle/executions/${executionId}/rows?limit=100`);
    const countAfterFirst = (rowsAfterFirst.data as unknown as unknown[]).length;

    drain('execution');
    const rowsAfterSecond = await api('GET', `/import/lifecycle/executions/${executionId}/rows?limit=100`);
    expect((rowsAfterSecond.data as unknown as unknown[]).length).toBe(countAfterFirst);

    // And the catalogue holds each imported SKU exactly once.
    const duplicates = execFileSync(
      'psql',
      [
        disposableDatabaseUrl(),
        '-tAc',
        `select count(*) from (select sku from products where sku like 'RESUME-%' group by sku having count(*) > 1) d`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(duplicates).toBe('0');
  }, 600_000);

  /* ------------------------------------------------------------- refusals */

  it('refuses another company’s source, mapping and plan alike', async () => {
    const ticket = await api('POST', '/import/lifecycle/sources/ticket', {
      fileName: 'ours.csv',
      contentType: 'text/csv',
      maxBytes: 1024,
    });
    const { url, headers, objectKey } = ticket.data as unknown as {
      url: string;
      headers: Record<string, string>;
      objectKey: string;
    };
    await fetch(url, { method: 'PUT', headers, body: CSV });

    const ours = await api('POST', '/import/lifecycle/sources', {
      objectKey,
      originalFileName: 'ours.csv',
      sizeBytes: Buffer.byteLength(CSV),
      detectedFormat: 'CSV_OR_TEXT',
    });
    const sourceId = (ours.data as unknown as { id: string }).id;

    // The other company asking for our source gets 404, never 403: telling
    // them it exists would confirm a record they cannot see.
    const theirs = await api('GET', `/import/lifecycle/sources/${sourceId}`, undefined, theirToken);
    expect(theirs.status).toBe(404);

    // And cannot start an analysis on it either.
    const theirAnalysis = await api('POST', `/import/lifecycle/sources/${sourceId}/analysis`, {}, theirToken);
    expect(theirAnalysis.status).toBe(404);
  }, 300_000);

  it('refuses a plan naming a shop in another company', async () => {
    const ticket = await api('POST', '/import/lifecycle/sources/ticket', {
      fileName: 'cross.csv',
      contentType: 'text/csv',
      maxBytes: 1024,
    });
    const { url, headers, objectKey } = ticket.data as unknown as {
      url: string;
      headers: Record<string, string>;
      objectKey: string;
    };
    await fetch(url, { method: 'PUT', headers, body: CSV });
    const source = await api('POST', '/import/lifecycle/sources', {
      objectKey,
      originalFileName: 'cross.csv',
      sizeBytes: Buffer.byteLength(CSV),
      detectedFormat: 'CSV_OR_TEXT',
    });

    const plan = await api('POST', '/import/lifecycle/plans', {
      sourceId: (source.data as unknown as { id: string }).id,
      importType: 'HISTORICAL_STORE_SALES',
      // A shop that exists — in somebody else's company.
      storeId: ready.theirs.centro,
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [{ columnIndex: 0, header: 'sku', field: 'sku', reviewed: true }],
      },
      sample: { headers: ['sku'], rows: [['A-1']], firstRowNumber: 2 },
      columnTypes: ['TEXT'],
    });

    expect(plan.status).toBe(404);
  }, 300_000);

  it('refuses an approval proof that has already been spent', async () => {
    const ticket = await api('POST', '/import/lifecycle/sources/ticket', {
      fileName: 'stale.csv',
      contentType: 'text/csv',
      maxBytes: 1024,
    });
    const { url, headers, objectKey } = ticket.data as unknown as {
      url: string;
      headers: Record<string, string>;
      objectKey: string;
    };
    const csv = 'sku,nombre\nSTALE-1,Repetido\n';
    await fetch(url, { method: 'PUT', headers, body: csv });
    const source = await api('POST', '/import/lifecycle/sources', {
      objectKey,
      originalFileName: 'stale.csv',
      sizeBytes: Buffer.byteLength(csv),
      detectedFormat: 'CSV_OR_TEXT',
    });

    const plan = await api('POST', '/import/lifecycle/plans', {
      sourceId: (source.data as unknown as { id: string }).id,
      importType: 'PRODUCTS',
      mapping: {
        sheet: 'main',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
          { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
        ],
      },
      sample: { headers: ['sku', 'nombre'], rows: [['STALE-1', 'Repetido']], firstRowNumber: 2 },
      columnTypes: ['TEXT', 'TEXT'],
    });
    const planId = (plan.data as unknown as { id: string }).id;

    const approval = await api('POST', `/import/lifecycle/plans/${planId}/approve`);
    const proof = (approval.data as unknown as { proof: string }).proof;

    const first = await api('POST', `/import/lifecycle/plans/${planId}/execute`, { proof });
    expect(first.status).toBe(201);

    // A plan runs ONCE, ever — enforced by a unique index rather than a check
    // two requests could both pass.
    const second = await api('POST', `/import/lifecycle/plans/${planId}/execute`, { proof });
    expect(second.status).toBe(409);
  }, 300_000);
});

/** Let the wizard's chained effects and polls settle against a real server. */
async function settle(rendered: { rerender: unknown }, times: number): Promise<void> {
  void rendered;
  for (let i = 0; i < times; i++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}
