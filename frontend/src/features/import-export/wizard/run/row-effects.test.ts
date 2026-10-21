import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeEffects } from './row-effects';
import type { RowEffects } from '../api/lifecycle.service';

/**
 * The browser is held to the same phrasing contract as the server's report.
 *
 * Read from the server's fixture on purpose, rather than copied. A screen and a
 * spreadsheet that describe one run in two different vocabularies is the defect
 * this feature exists to close, and two copies of the same strings drift the
 * first time somebody edits one of them.
 */
const CONTRACT = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../../../backend/test/fixtures/row-effect-phrases.json'),
    'utf8',
  ),
) as {
  cases: {
    name: string;
    effects: RowEffects | null;
    expect: { product: string; store: string; categories: string; stock: string };
  }[];
};

describe('the screen and the report agree, phrase for phrase', () => {
  it.each(CONTRACT.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    expect(describeEffects(testCase.effects)).toEqual(testCase.expect);
  });
});

describe('describing a row that recorded nothing', () => {
  it('says so for an absent field as well as a null one', () => {
    // `undefined` reaches here from a server that has not been redeployed yet,
    // `null` from a row written before the column existed. Same answer.
    expect(describeEffects(undefined)).toEqual(describeEffects(null));
    expect(describeEffects(undefined).product).toBe('not recorded');
  });

  it('never renders a legacy row as though nothing was asked of it', () => {
    const described = describeEffects(null);
    expect(Object.values(described)).not.toContain('not requested');
  });

  it('leaves no cell blank', () => {
    // A blank cell reads as "nothing happened". Every cell has to make a claim.
    for (const value of Object.values(describeEffects(null))) expect(value.length).toBeGreaterThan(0);
  });
});

describe('describing states this build has never seen', () => {
  it('renders a newer server’s state readably rather than blank', () => {
    // The frontend deploys separately from the backend. A state added on the
    // server must not produce an empty cell here in the window between them.
    const described = describeEffects({ product: { state: 'SUPERSEDED_BY_LATER_ROW' } });
    expect(described.product).toBe('superseded by later row');
  });
});
