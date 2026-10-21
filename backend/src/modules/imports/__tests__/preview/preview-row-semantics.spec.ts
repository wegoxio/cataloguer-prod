import { GenericImportService } from '../../preview/generic-import.service';

/**
 * Row accounting must count parsed RECORDS, not physical lines (#172): a quoted
 * field spanning newlines is one row, and the header is never counted as data.
 */
describe('preview row semantics', () => {
  const svc = new GenericImportService({} as any);
  const file = (body: string) => ({ originalname: 'catalog.csv', mimetype: 'text/csv', buffer: Buffer.from(body) });

  it('counts a quoted embedded newline as ONE data row, not two', () => {
    const p = svc.preview('products', file('Nombre,Descripcion\n"Silla","Comoda\ncon reposabrazos"'));
    expect(p.fileRows).toBe(1);
    expect(p.totalRows).toBe(1);
  });

  it('never counts the header row as data', () => {
    const p = svc.preview('products', file('Nombre,Precio\nSilla,10\nMesa,20'));
    expect(p.fileRows).toBe(2);
    expect(p.headers).toEqual(['Nombre', 'Precio']);
  });

  it('accepts a header-only file with zero data rows', () => {
    const p = svc.preview('products', file('Nombre,Precio\n'));
    expect(p.totalRows).toBe(0);
    expect(p.fileRows).toBe(0);
    expect(p.rows).toEqual([]);
  });

  it('rejects a file that parses to no rows at all', () => {
    expect(() => svc.preview('products', file('\n\n\n'))).toThrow(/no rows/);
  });
});
