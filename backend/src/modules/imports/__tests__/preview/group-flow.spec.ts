import { GenericImportService } from '../../preview/generic-import.service';

describe('import proposes variant groups', () => {
  const svc = new GenericImportService({} as any);

  it('offers groups for a supplier-style product file', () => {
    const csv = [
      'Nombre,Precio,Categoria',
      'Silla Lounge Walter Verde,1.020,Sillas',
      'Silla Lounge Walter Marron,1.020,Sillas',
      'Mesa Comedor Almira,2.500,Mesas',
    ].join('\n');

    const p = svc.preview('products', {
      originalname: 'proveedor.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from(csv),
    });

    expect(p.groupProposals).toHaveLength(1);
    expect(p.groupProposals[0].name).toBe('Silla Lounge Walter');
    expect(p.groupProposals[0].members.map((m) => m.label)).toEqual(['Verde', 'Marron']);
    // The member carries its full name so commit can resolve it after chunking
    expect(p.groupProposals[0].members[0].name).toBe('Silla Lounge Walter Verde');
  });

  it('offers nothing for categories or when names are all distinct', () => {
    const distinct = svc.preview('products', {
      originalname: 'f.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from('Nombre,Precio\nEscritorio Kaat,100\nAlfombra Lake,80'),
    });
    expect(distinct.groupProposals).toEqual([]);

    const cats = svc.preview('categories', {
      originalname: 'c.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from('Nombre\nSillas\nMesas'),
    });
    expect(cats.groupProposals).toEqual([]);
  });
});
