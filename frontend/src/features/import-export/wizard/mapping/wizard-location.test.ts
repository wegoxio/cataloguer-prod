import { describe, expect, it } from 'vitest';
import { decodeWizardLocation, encodeWizardLocation, resolveLink } from './wizard-location';

/**
 * Links into the wizard.
 *
 * Import work is interrupted constantly, so a link has to survive being pasted
 * into a chat message, mangled by the client that "helpfully" fixes it, and
 * opened three months later when the file behind it is long gone.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('what travels in a link', () => {
  it('carries identifiers and a position', () => {
    const query = encodeWizardLocation({ sourceId: UUID, importType: 'PRODUCTS', region: 'ISSUES', column: 3, row: 42 });
    const decoded = decodeWizardLocation(query);
    expect(decoded).toEqual({ sourceId: UUID, importType: 'PRODUCTS', region: 'ISSUES', column: 3, row: 42 });
  });

  it('carries NO data from the file', () => {
    // A URL is copied into tickets and chat, and logged by every proxy in
    // between. A customer's prices must not ride along.
    const query = encodeWizardLocation({ sourceId: UUID, importType: 'PRODUCTS', region: 'RESULT', column: 1 });
    expect(query).not.toMatch(/Camiseta|19,99|Precio|Nombre/);
    // Only the known keys, whatever else a caller might have hoped to add.
    const keys: string[] = [];
    new URLSearchParams(query.replace('?', '')).forEach((_value, key) => keys.push(key));
    expect(keys.sort()).toEqual(['at', 'col', 'source', 'type']);
  });

  it('produces nothing at all for an empty location', () => {
    expect(encodeWizardLocation({})).toBe('');
  });

  it('round-trips a location holding only a source', () => {
    expect(decodeWizardLocation(encodeWizardLocation({ sourceId: UUID }))).toEqual({ sourceId: UUID });
  });
});

describe('a mangled link keeps its useful half', () => {
  it('opens the source even when the region is nonsense', () => {
    // Rejecting the whole link would throw away the part that still works, and
    // links get mangled routinely.
    const decoded = decodeWizardLocation(`?source=${UUID}&at=somewhere`);
    expect(decoded.sourceId).toBe(UUID);
    expect(decoded.region).toBeUndefined();
  });

  it('accepts a region in any casing', () => {
    expect(decodeWizardLocation('?at=issues').region).toBe('ISSUES');
    expect(decodeWizardLocation('?at=Issues').region).toBe('ISSUES');
  });

  it('discards a source id that is not one of ours', () => {
    // Anything in that slot that is not a UUID did not come from us, and
    // passing it through would send it to the server as though it had.
    for (const bad of ['../etc/passwd', "1' or '1'='1", 'not-a-uuid', '']) {
      expect(decodeWizardLocation(`?source=${encodeURIComponent(bad)}`).sourceId).toBeUndefined();
    }
  });

  it('discards an import type this build does not know', () => {
    expect(decodeWizardLocation('?type=EVERYTHING').importType).toBeUndefined();
  });

  it('discards positions that are not plausible', () => {
    for (const bad of ['-1', '1e9', 'abc', '1.5', '99999999']) {
      expect(decodeWizardLocation(`?col=${bad}`).column).toBeUndefined();
    }
    // Rows are 1-based as the person sees them, so 0 is not a row.
    expect(decodeWizardLocation('?row=0').row).toBeUndefined();
    expect(decodeWizardLocation('?row=1').row).toBe(1);
  });

  it('accepts column zero, which is a real column', () => {
    expect(decodeWizardLocation('?col=0').column).toBe(0);
  });

  it('survives an empty or absurd query string', () => {
    expect(decodeWizardLocation('')).toEqual({});
    expect(decodeWizardLocation('?')).toEqual({});
    expect(decodeWizardLocation('?a=1&b=2&c=3')).toEqual({});
  });

  it('accepts URLSearchParams directly, as a router would supply them', () => {
    const params = new URLSearchParams({ source: UUID, at: 'result' });
    expect(decodeWizardLocation(params)).toEqual({ sourceId: UUID, region: 'RESULT' });
  });
});

describe('opening a link whose file is gone', () => {
  it('opens it when the source is still there', () => {
    expect(resolveLink({ sourceId: UUID }, 'AVAILABLE')).toEqual({ kind: 'OPEN', sourceId: UUID });
  });

  it('explains an expired source in the words the person needs', () => {
    // Ninety days is the stated retention, and "upload it again" is the actual
    // next step — not an error page.
    const outcome = resolveLink({ sourceId: UUID }, 'EXPIRED');
    expect(outcome.kind).toBe('START_OVER');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('90 days') });
    expect(outcome).toMatchObject({ reason: expect.stringContaining('Upload it again') });
  });

  it('says the same thing for missing and for forbidden', () => {
    // Distinguishing them would tell the reader a file exists in a company they
    // cannot see, which is itself a disclosure — and the link was probably
    // shared by mistake.
    const missing = resolveLink({ sourceId: UUID }, 'MISSING');
    const forbidden = resolveLink({ sourceId: UUID }, 'FORBIDDEN');
    expect(forbidden).toEqual(missing);
    expect(missing).toMatchObject({ reason: expect.stringContaining('no longer available') });
  });

  it('lands on a fresh start when the link named no source', () => {
    expect(resolveLink({}, 'NONE')).toMatchObject({ kind: 'START_OVER', reason: 'Choose a file to import.' });
  });

  it('never resolves to an error, only to somewhere to go next', () => {
    const statuses = ['AVAILABLE', 'EXPIRED', 'MISSING', 'FORBIDDEN', 'NONE'] as const;
    for (const status of statuses) {
      const outcome = resolveLink({ sourceId: UUID }, status);
      expect(['OPEN', 'START_OVER', 'RESUME_ELSEWHERE']).toContain(outcome.kind);
      if (outcome.kind !== 'OPEN') expect(outcome.reason.length).toBeGreaterThan(10);
    }
  });
});
