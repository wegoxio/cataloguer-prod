import { decide } from './reclassify-designhof-tables.main';

const product = (
  slugs: string[],
  overrides: Partial<{ id: string; name: string; manufacturer_code: string | null }> = {},
) => ({
  id: overrides.id ?? '00000000-0000-0000-0000-000000000001',
  name: overrides.name ?? 'Producto',
  manufacturer_code: overrides.manufacturer_code ?? null,
  slugs,
});

describe('DesignHof table reclassification decisions', () => {
  it('maps a classified normal dining table without guessing from its name', () => {
    expect(decide(product(['mobiliario-mesas', 'mobiliario-mesas-comedor']))).toMatchObject({
      status: 'MIGRATE',
      catalogue: 'GENERAL',
      target: 'DINING',
    });
  });

  it('merges normal centre and auxiliary evidence into one target', () => {
    expect(
      decide(product(['mobiliario-mesas', 'mobiliario-mesas-centro', 'mobiliario-mesas-auxiliares'])),
    ).toMatchObject({
      status: 'MIGRATE',
      catalogue: 'GENERAL',
      target: 'CENTER_AUX',
    });
  });

  it('recognizes the imported New In H1 batch even before it has H1 categories', () => {
    expect(decide(product(['new-in', 'mobiliario-mesas-comedor'], { manufacturer_code: 'H11000123' }))).toMatchObject({
      status: 'MIGRATE',
      catalogue: 'H1',
      target: 'DINING',
    });
  });

  it('leaves a generic-only table for human review', () => {
    expect(decide(product(['mobiliario-mesas'], { name: 'Dining Table obvious to a human' }))).toMatchObject({
      status: 'REVIEW',
      reason: expect.stringContaining('no se infiere'),
    });
  });

  it('leaves conflicting product types untouched', () => {
    expect(
      decide(
        product(['mobiliario-h1-coleccion-h1-mesas-auxiliares-ch1', 'mobiliario-h1-coleccion-h1-bancos-pouffs-ch1']),
      ),
    ).toMatchObject({
      status: 'REVIEW',
      reason: expect.stringContaining('categorías no-mesa'),
    });
  });

  it('leaves incompatible table targets untouched', () => {
    expect(decide(product(['mobiliario-mesas-comedor', 'mobiliario-mesas-centro']))).toMatchObject({
      status: 'REVIEW',
      reason: expect.stringContaining('incompatibles'),
    });
  });
});
