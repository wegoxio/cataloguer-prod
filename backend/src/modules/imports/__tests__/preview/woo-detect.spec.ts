import { GenericImportService } from '../../preview/generic-import.service';

describe('wizard on a WooCommerce export', () => {
  const svc = new GenericImportService({} as any);
  const csv = [
    'ID,Name,SKU,Regular price,Sale price,Stock,Categories,Images,Description',
    '12,Silla Nordica,CH-01,1.020,890,5,Sillas,https://x.io/a.jpg\\, https://x.io/b.jpg,Comoda',
  ].join('\n');

  it.each(['Images', 'Photos', 'Photo', 'Fotos', 'Imagen', 'Pictures', 'Gallery', 'Galería'])(
    'recognises "%s" as the photo column',
    (header) => {
      const p = svc.preview('products', {
        originalname: 'f.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from(`Name,${header}\nSilla,https://x.io/a.jpg`),
      });
      expect(p.mapping.images).toBe(1);
    },
  );

  it('detects the Woo photo, sale-price and category columns', () => {
    const p = svc.preview('products', { originalname: 'woo.csv', mimetype: 'text/csv', buffer: Buffer.from(csv) });
    expect(p.headers[7]).toBe('Images');
    expect(p.mapping.images).toBe(7);
    expect(p.mapping.salePrice).toBe(4);
    expect(p.mapping.price).toBe(3);
    expect(p.mapping.category).toBe(6);
    expect(p.mapping.sku).toBe(2);
  });
});
