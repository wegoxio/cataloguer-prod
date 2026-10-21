import { BadRequestException } from '@nestjs/common';
import { validateAndDecodeCsv } from '../csv-upload.validator';

/**
 * The single content gate both CSV import routes pass through (#172). It must
 * reject Excel and binary payloads with user-safe messages and return decoded
 * text for genuine CSV — without ever invoking a CSV parser.
 */
describe('validateAndDecodeCsv', () => {
  const csv = (name: string, mimetype: string, body: Buffer | string) => ({
    originalname: name,
    mimetype,
    buffer: typeof body === 'string' ? Buffer.from(body) : body,
  });

  it('accepts a genuine UTF-8 CSV and returns its text', () => {
    const text = validateAndDecodeCsv(csv('stock.csv', 'text/csv', 'Nombre,Precio\nSilla,10'));
    expect(text).toBe('Nombre,Precio\nSilla,10');
  });

  it('accepts a .CSV extension regardless of case', () => {
    expect(() => validateAndDecodeCsv(csv('STOCK.CSV', 'text/csv', 'a,b\n1,2'))).not.toThrow();
  });

  it('rejects an empty file', () => {
    expect(() => validateAndDecodeCsv(csv('stock.csv', 'text/csv', ''))).toThrow(BadRequestException);
    expect(() =>
      validateAndDecodeCsv({ originalname: 'x.csv', mimetype: 'text/csv', buffer: undefined as any }),
    ).toThrow(/vacío|no se recibió/);
  });

  it('rejects .xlsx and .xls with CSV guidance (no CVE/dependency detail)', () => {
    for (const name of ['book.xlsx', 'book.xls', 'BOOK.XLSX']) {
      try {
        validateAndDecodeCsv(csv(name, 'application/vnd.ms-excel', 'PK\x03\x04binary'));
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as Error).message).toMatch(/Excel no está disponible.*Exporta el archivo como CSV/);
        expect((e as Error).message).not.toMatch(/xlsx|CVE|prototype|ReDoS/i);
      }
    }
  });

  it('rejects any non-CSV extension', () => {
    expect(() => validateAndDecodeCsv(csv('data.json', 'text/csv', '{}'))).toThrow(/Solo se admiten archivos CSV/);
    expect(() => validateAndDecodeCsv(csv('noext', 'text/csv', 'a,b'))).toThrow(/Solo se admiten archivos CSV/);
  });

  it('rejects a .csv whose declared MIME is not on the allowlist', () => {
    expect(() => validateAndDecodeCsv(csv('stock.csv', 'application/pdf', 'a,b\n1,2'))).toThrow(
      /no corresponde a un CSV/,
    );
  });

  it('accepts every allowlisted MIME (incl. parameterised charset) and an absent MIME', () => {
    for (const mime of [
      'text/csv',
      'application/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/octet-stream',
      'text/csv; charset=utf-8',
    ]) {
      expect(() => validateAndDecodeCsv(csv('stock.csv', mime, 'a,b\n1,2'))).not.toThrow();
    }
    // Missing MIME entirely is allowed — extension + content still gate it
    expect(() =>
      validateAndDecodeCsv({ originalname: 'stock.csv', mimetype: undefined, buffer: Buffer.from('a,b') }),
    ).not.toThrow();
  });

  it('rejects invalid UTF-8 byte sequences', () => {
    // 0xFF is never valid UTF-8
    const bad = Buffer.from([0x61, 0x2c, 0x62, 0xff, 0x0a]);
    expect(() => validateAndDecodeCsv(csv('stock.csv', 'text/csv', bad))).toThrow(/UTF-8/);
  });

  it('strips a single leading UTF-8 BOM', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Nombre,Precio\nSilla,10')]);
    const text = validateAndDecodeCsv(csv('stock.csv', 'text/csv', withBom));
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.startsWith('Nombre')).toBe(true);
  });

  it('rejects NUL and other C0 control bytes as binary', () => {
    const withNul = Buffer.from([0x61, 0x2c, 0x62, 0x00, 0x0a]);
    expect(() => validateAndDecodeCsv(csv('stock.csv', 'text/csv', withNul))).toThrow(/binarios|binario/);
    // 0x07 (BEL) is a disallowed control
    const withBell = Buffer.from([0x61, 0x2c, 0x62, 0x07]);
    expect(() => validateAndDecodeCsv(csv('stock.csv', 'text/csv', withBell))).toThrow(/binario/);
  });

  it('permits tab, LF and CR inside CSV content', () => {
    expect(() => validateAndDecodeCsv(csv('stock.csv', 'text/csv', 'a\tb,c\r\n1\t2,3\r\n'))).not.toThrow();
  });
});
