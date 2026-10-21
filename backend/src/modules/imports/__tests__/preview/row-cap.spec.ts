import { GenericImportService } from '../../preview/generic-import.service';

/**
 * DesignHof's real 841-row export must import whole. Preview accepts up to
 * 5,000 data rows; beyond that the file is REJECTED (not truncated) — #172.
 * Commits stay bounded per request because the panel chunks at 50.
 */
describe('import row caps', () => {
  const svc = new GenericImportService({} as any);
  const fileOf = (rows: number) => ({
    originalname: 'catalog.csv',
    mimetype: 'text/csv',
    buffer: Buffer.from('Nombre,Precio\n' + Array.from({ length: rows }, (_, i) => `Producto ${i},10`).join('\n')),
  });

  it('takes DesignHof-sized files whole (841 rows, the file that hit the old cap)', () => {
    const p = svc.preview('products', fileOf(841));

    expect(p.totalRows).toBe(841);
    expect(p.truncated).toBe(false);
    expect(p.fileRows).toBe(841);
  });

  it('accepts exactly the cap (5,000 data rows)', () => {
    const p = svc.preview('products', fileOf(5000));

    expect(p.totalRows).toBe(5000);
    expect(p.truncated).toBe(false);
  });

  it('rejects a file one row over the cap — never truncates (#172)', () => {
    expect(() => svc.preview('products', fileOf(5001))).toThrow(/demasiadas filas/);
  });
});
