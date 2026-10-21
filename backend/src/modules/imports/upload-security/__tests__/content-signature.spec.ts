import { detectFormat, verifySignature } from '../content-signature';

const buf = (...bytes: number[]) => Buffer.from(bytes);
const text = (s: string) => Buffer.from(s, 'utf8');

describe('content-signature detection', () => {
  describe('detectFormat', () => {
    it('recognizes a ZIP container, which is what every xlsx really is', () => {
      expect(detectFormat(buf(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe('ZIP_CONTAINER');
      expect(detectFormat(buf(0x50, 0x4b, 0x05, 0x06))).toBe('ZIP_CONTAINER');
    });

    it('recognizes the OLE2 compound file a legacy .xls actually is', () => {
      expect(detectFormat(buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('OLE2');
    });

    it('recognizes PDFs and images so they are diagnosed, not parsed', () => {
      expect(detectFormat(text('%PDF-1.7'))).toBe('PDF');
      expect(detectFormat(buf(0x89, 0x50, 0x4e, 0x47))).toBe('IMAGE');
      expect(detectFormat(buf(0xff, 0xd8, 0xff, 0xe0))).toBe('IMAGE');
    });

    it('treats real CSV as text, including with a BOM', () => {
      expect(detectFormat(text('name,price\nSofá,100'))).toBe('CSV_OR_TEXT');
      expect(detectFormat(Buffer.concat([buf(0xef, 0xbb, 0xbf), text('ID,Tipo')]))).toBe('CSV_OR_TEXT');
    });

    it('classifies NUL-bearing content as binary rather than text', () => {
      expect(detectFormat(Buffer.concat([text('name,price'), buf(0x00), text('junk')]))).toBe('UNKNOWN_BINARY');
    });

    it('classifies an empty buffer as unknown rather than as valid text', () => {
      expect(detectFormat(Buffer.alloc(0))).toBe('UNKNOWN_BINARY');
    });
  });

  describe('verifySignature', () => {
    it('accepts a genuine CSV named .csv', () => {
      expect(verifySignature('products.csv', text('a,b\n1,2'))).toMatchObject({ ok: true, detected: 'CSV_OR_TEXT' });
    });

    it('accepts a genuine zip-container workbook named .xlsx', () => {
      expect(verifySignature('book.xlsx', buf(0x50, 0x4b, 0x03, 0x04))).toMatchObject({
        ok: true,
        detected: 'ZIP_CONTAINER',
      });
    });

    it('refuses a renamed binary — the exact case extension-trust allowed through', () => {
      // A zip renamed to .csv previously passed: the extension matched and
      // `application/octet-stream` was allow-listed.
      const v = verifySignature('totally-a.csv', buf(0x50, 0x4b, 0x03, 0x04));
      expect(v.ok).toBe(false);
      expect(v.detected).toBe('ZIP_CONTAINER');
      expect(v.reason).toContain('compressed workbook');
    });

    it('refuses a text file renamed .xlsx', () => {
      const v = verifySignature('fake.xlsx', text('name,price\n1,2'));
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('plain text');
    });

    it('refuses .xls with actionable guidance instead of a generic failure', () => {
      const v = verifySignature('old.xls', buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('Save as');
      expect(v.reason).toMatch(/\.xlsx or \.csv/);
    });

    it('refuses an unsupported extension by name', () => {
      const v = verifySignature('notes.pdf', text('%PDF-1.7'));
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('Unsupported file type');
    });

    it('never echoes file content back in the refusal message', () => {
      const secret = 'SUPER-SECRET-VALUE-12345';
      const v = verifySignature('x.xlsx', text(`a,b\n${secret},2`));
      expect(v.ok).toBe(false);
      expect(v.reason).not.toContain(secret);
    });
  });
});
