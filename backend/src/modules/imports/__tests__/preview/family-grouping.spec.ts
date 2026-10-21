import { confidentGroups, proposeGroups } from '../../preview/family-grouping';

describe('proposeGroups', () => {
  it('groups colours of one model and labels them', () => {
    const groups = proposeGroups([
      'Lounge Chair Walter Green',
      'Lounge Chair Walter Brown',
      'Dining Table Almira Round Walnut',
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Lounge Chair Walter');
    expect(groups[0].members.map((m) => m.label)).toEqual(['Green', 'Brown']);
    expect(groups[0].confident).toBe(true);
  });

  it('leaves a lone item alone', () => {
    expect(proposeGroups(['Coffee table Tiles Blue', 'Desk Kaat Natural Oak'])).toEqual([]);
  });

  it('prefers the most specific model over a broader shared prefix', () => {
    const groups = proposeGroups([
      'Chair Walter Wide Green',
      'Chair Walter Wide Brown',
      'Chair Walter Slim Green',
      'Chair Walter Slim Brown',
    ]);

    expect(groups.map((g) => g.name).sort()).toEqual(['Chair Walter Slim', 'Chair Walter Wide']);
    groups.forEach((g) => expect(g.members).toHaveLength(2));
  });

  it('does not group two rows that differ by nothing but read alike', () => {
    // Same leftover twice means duplicate rows, not two versions
    expect(proposeGroups(['Side Table Noble Square', 'Side Table Noble Square'])).toEqual([]);
  });

  it('flags a group as unconfident when the leftovers are not colours or sizes', () => {
    const groups = proposeGroups(['Office Desk Pro 120', 'Office Desk Pro 140']);

    expect(groups).toHaveLength(1);
    expect(groups[0].confident).toBe(false);
  });

  it('never puts one row in two groups', () => {
    const groups = proposeGroups(['Sofa Echo Blue', 'Sofa Echo Red', 'Sofa Echo Blue Dark']);
    const rows = groups.flatMap((g) => g.members.map((m) => m.row));

    expect(new Set(rows).size).toBe(rows.length);
  });

  it('requires at least two shared leading words', () => {
    // "Chair Green" / "Chair Brown" share only one word — too weak to assume
    expect(proposeGroups(['Chair Green', 'Chair Brown'])).toEqual([]);
  });
});

describe('confidentGroups', () => {
  it('keeps colour groups and drops a brand that merely shares words', () => {
    const groups = confidentGroups([
      'Floor Lamp Tripod White',
      'Floor Lamp Tripod Black',
      // A brand prefix with model numbers — not variants of one thing
      'ROLF BENZ 310',
      'ROLF BENZ 8290',
      'ROLF BENZ KUMO',
    ]);

    expect(groups.map((g) => g.name)).toEqual(['Floor Lamp Tripod']);
  });
});

describe('measurement leftovers (no word list could hold them)', () => {
  it.each([
    ['dimensions', ['Colchon Norte 160x200', 'Colchon Norte 90x190']],
    ['measures with units', ['Espejo Luna 90 cm', 'Espejo Luna 120 cm']],
    ['seat counts', ['Sofa Marta 2 plazas', 'Sofa Marta 3 plazas']],
  ])('trusts %s as version labels', (_kind, names) => {
    const groups = confidentGroups(names);

    expect(groups).toHaveLength(1);
  });

  it('still refuses bare number series — model lines look the same', () => {
    expect(confidentGroups(['Office Desk Pro 120', 'Office Desk Pro 140'])).toEqual([]);
  });
});

describe('unknown repeated leftovers', () => {
  const fabricCatalogue = [
    // "Terra"/"Vintage" are this supplier's fabrics — on no word list,
    // but repeated under three different models in the same file
    'Sofa Marta Terra',
    'Sofa Marta Vintage',
    'Sofa Lund Terra',
    'Sofa Lund Vintage',
    'Butaca Rio Terra',
    'Butaca Rio Vintage',
  ];

  it('does not turn repeated model names into variant vocabulary without human confirmation', () => {
    expect(confidentGroups(fabricCatalogue)).toEqual([]);
  });

  it('does not learn from a single pair — twice is coincidence', () => {
    expect(confidentGroups(['Sofa Marta Terra', 'Sofa Marta Vintage'])).toEqual([]);
  });
});

describe('the SKU as a second witness', () => {
  it('confirms a family whose SKUs share a stem with letter suffixes', () => {
    const groups = confidentGroups([
      { name: 'Lounge Chair Walter Terra', sku: 'WALT-TER' },
      { name: 'Lounge Chair Walter Vintage', sku: 'WALT-VIN' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.label)).toEqual(['Terra', 'Vintage']);
  });

  it('rejects purely numeric SKU series — sequential codes are model lines', () => {
    expect(
      confidentGroups([
        { name: 'Office Desk Pro Alpha', sku: 'PRO-120' },
        { name: 'Office Desk Pro Beta', sku: 'PRO-140' },
      ]),
    ).toEqual([]);
  });

  it('needs every member to carry a SKU before trusting the stem', () => {
    expect(
      confidentGroups([
        { name: 'Lounge Chair Walter Terra', sku: 'WALT-TER' },
        { name: 'Lounge Chair Walter Vintage', sku: null },
      ]),
    ).toEqual([]);
  });

  it('still accepts plain string input for callers without SKUs', () => {
    const groups = confidentGroups(['Floor Lamp Tripod White', 'Floor Lamp Tripod Black']);

    expect(groups).toHaveLength(1);
  });
});

describe('what the company taught us (phase 2)', () => {
  it('trusts labels made of learned words', () => {
    // "Terra"/"Vintage" alone are not confident — unless this company taught them
    const names = ['Sofa Marta Terra', 'Sofa Marta Vintage'];

    expect(confidentGroups(names)).toEqual([]);
    expect(confidentGroups(names, { learnedWords: ['terra', 'vintage'] })).toHaveLength(1);
  });

  it('never proposes a dismissed model name again', () => {
    const names = ['Floor Lamp Tripod White', 'Floor Lamp Tripod Black'];

    expect(confidentGroups(names)).toHaveLength(1);
    expect(confidentGroups(names, { dismissedSignatures: ['floor lamp tripod'] })).toEqual([]);
  });
});
