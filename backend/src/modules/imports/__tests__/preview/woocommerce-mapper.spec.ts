import { parseWooCommerceCsv, slugify, stripHtml } from '../../preview/woocommerce-mapper';

const WOO_CSV = `ID,Type,SKU,Name,Published,Short description,Description,Sale price,Regular price,Categories,Images,Parent,Stock,Attribute 1 name,Attribute 1 value(s),Attribute 2 name,Attribute 2 value(s)
101,simple,MUG-01,Café Mug,1,"<p>A <strong>great</strong> mug</p>","<p>Ceramic mug, 350ml</p>",8.50,12.00,"Kitchen > Drinkware, Sale","https://old-shop.com/mug1.jpg, https://old-shop.com/mug2.jpg",,25,,,,
102,variable,SHIRT,Classic Shirt,1,,"<p>Cotton shirt</p>",,,Clothing > Shirts,https://old-shop.com/shirt.jpg,,,Size,"S | M | L",Color,"Blue | Black"
103,variation,SHIRT-S-BLUE,Classic Shirt - S Blue,1,,,,19.99,,,id:102,10,Size,S,Color,Blue
104,variation,SHIRT-M-BLACK,Classic Shirt - M Black,1,,,15.00,22.00,,,id:102,0,Size,M,Color,Black
105,simple,,Draft Thing,0,,,,5.00,,,,,,,,
106,variation,ORPHAN-1,Orphan Variation,1,,,,9.99,,,id:999,3,,,,
107,grouped,GRP-1,Grouped Product,1,,,,10.00,,,,,,,,`;

describe('woocommerce-mapper', () => {
  it('slugifies names with diacritics and symbols', () => {
    expect(slugify('Café Mug & Co.')).toBe('cafe-mug-co');
  });

  it('strips HTML and entities from descriptions', () => {
    expect(stripHtml('<p>A <strong>great</strong> mug &amp; more</p>')).toBe('A great mug & more');
  });

  it('parses the full Woo export shape', () => {
    const { products, errors } = parseWooCommerceCsv(WOO_CSV);

    expect(products).toHaveLength(3); // mug, shirt, draft thing

    const mug = products.find((p) => p.sku === 'MUG-01')!;
    expect(mug.slug).toBe('cafe-mug');
    expect(mug.published).toBe(true);
    expect(mug.price).toBe(12);
    expect(mug.salePrice).toBe(8.5);
    expect(mug.stockQuantity).toBe(25);
    expect(mug.trackInventory).toBe(true);
    expect(mug.categoryPath).toEqual(['Kitchen', 'Drinkware']); // first path only
    expect(mug.imageUrls).toEqual(['https://old-shop.com/mug1.jpg', 'https://old-shop.com/mug2.jpg']);
    expect(mug.description).toBe('Ceramic mug, 350ml');
    expect(mug.metaDescription).toBe('A great mug');

    const shirt = products.find((p) => p.sku === 'SHIRT')!;
    expect(shirt.variations).toHaveLength(2);
    expect(shirt.price).toBe(19.99); // cheapest variation price inherited

    const sBlue = shirt.variations.find((v) => v.sku === 'SHIRT-S-BLUE')!;
    expect(sBlue.price).toBe(19.99);
    expect(sBlue.salePrice).toBeNull();
    expect(sBlue.attributes).toEqual({ Size: 'S', Color: 'Blue' });
    expect(sBlue.trackInventory).toBe(true);

    const mBlack = shirt.variations.find((v) => v.sku === 'SHIRT-M-BLACK')!;
    expect(mBlack.price).toBe(22);
    expect(mBlack.salePrice).toBe(15);
    expect(mBlack.stockQuantity).toBe(0);

    const draft = products.find((p) => p.name === 'Draft Thing')!;
    expect(draft.published).toBe(false);
    expect(draft.sku).toBeNull();
    expect(draft.trackInventory).toBe(false); // no Stock value

    // Orphan variation + unsupported type produce row errors
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('id:999') }),
        expect.objectContaining({ message: expect.stringContaining('grouped') }),
      ]),
    );
  });

  it('parses Spanish-localized exports (headers as produced by Spanish Woo sites)', () => {
    // Header set mirrors a real Venezuelan client export (Design Hof)
    const spanishCsv = `ID,Tipo,SKU,Nombre,Publicado,Visibilidad en el catálogo,Descripción corta,Descripción,¿Existencias?,Inventario,Precio rebajado,Precio normal,Categorías,Imágenes,Superior,Nombre del atributo 1,Valor(es) del atributo 1
201,simple,,Sofá Milano,1,visible,"<p>Sofá de lujo</p>","<p>Sofá tapizado en <b>cuero</b></p>",1,4,7500,8970,"MOBILIARIO > Sofás / Modulares, BEST SELLERS","https://design-hof.com/uploads/sofa1.png, https://design-hof.com/uploads/sofa2.png",,Material,Cuero
202,simple,,Lámpara París,1,visible,,"<p>Iluminación de techo</p>",1,,,,ILUMINACIÓN,https://design-hof.com/uploads/lampara.png,,,`;

    const { products, errors } = parseWooCommerceCsv(spanishCsv);

    expect(errors).toHaveLength(0);
    expect(products).toHaveLength(2);

    const sofa = products.find((p) => p.slug === 'sofa-milano')!;
    expect(sofa.name).toBe('Sofá Milano');
    expect(sofa.published).toBe(true);
    expect(sofa.price).toBe(8970);
    expect(sofa.salePrice).toBe(7500);
    expect(sofa.stockQuantity).toBe(4);
    expect(sofa.trackInventory).toBe(true);
    expect(sofa.categoryPath).toEqual(['MOBILIARIO', 'Sofás / Modulares']);
    expect(sofa.imageUrls).toEqual([
      'https://design-hof.com/uploads/sofa1.png',
      'https://design-hof.com/uploads/sofa2.png',
    ]);
    expect(sofa.description).toBe('Sofá tapizado en cuero');
    expect(sofa.metaDescription).toBe('Sofá de lujo');

    // Price-on-request product: no price columns filled
    const lampara = products.find((p) => p.slug === 'lampara-paris')!;
    expect(lampara.price).toBe(0);
    expect(lampara.salePrice).toBeNull();
    expect(lampara.trackInventory).toBe(false); // empty Inventario; ¿Existencias? flag must not leak into stock
  });
});
