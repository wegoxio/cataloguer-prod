import { EntityManager } from '@mikro-orm/postgresql';
import { MappingTemplateService, TemplateShape } from '../mapping-template.service';
import { ImportMappingTemplate } from '../../entities/import-mapping-template.entity';
import { TableMapping } from '../../preview/normalized-preview';
import { fingerprintSourceShape } from '../../plan/plan-hash';

/**
 * Re-binding a saved mapping to a file, which is the most dangerous thing the
 * wizard does.
 *
 * The whole point of the mapping step is that a person looked at it. A template
 * is a way of not looking, so everything here is about making the cases where
 * that matters impossible to miss.
 *
 * `applyToSource` needs no database, so it is tested directly rather than
 * through a stack that would obscure what is being asserted.
 */

// The service only touches the EntityManager in its persistence methods, none
// of which this suite calls.
const service = new MappingTemplateService(null as unknown as EntityManager);

const SAVED_SHAPE: TemplateShape = {
  headers: ['Nombre', 'SKU', 'Precio', 'Coste'],
  types: ['TEXT', 'TEXT', 'DECIMAL', 'DECIMAL'],
};

const SAVED_MAPPING: TableMapping = {
  sheet: 'Productos',
  headerRow: 1,
  columns: [
    { columnIndex: 0, header: 'Nombre', field: 'name' },
    { columnIndex: 1, header: 'SKU', field: 'sku' },
    {
      columnIndex: 2,
      header: 'Precio',
      field: 'price',
      transformations: [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }],
    },
    { columnIndex: 3, header: 'Coste', field: 'cost' },
  ],
};

function template(overrides: Partial<ImportMappingTemplate> = {}): ImportMappingTemplate {
  return {
    id: 'template-1',
    name: 'WooCommerce mensual',
    version: 1,
    importType: 'PRODUCTS',
    sourceFingerprint: fingerprintSourceShape(SAVED_SHAPE.headers, SAVED_SHAPE.types),
    sourceHeaders: SAVED_SHAPE,
    mapping: SAVED_MAPPING,
    ...overrides,
  } as ImportMappingTemplate;
}

const fieldFor = (mapping: TableMapping, header: string) =>
  mapping.columns.find((c) => c.header === header)?.field ?? null;

const indexFor = (mapping: TableMapping, header: string) =>
  mapping.columns.find((c) => c.header === header)?.columnIndex;

describe('an unchanged file', () => {
  it('reapplies cleanly with nothing to report', () => {
    const applied = service.applyToSource(template(), SAVED_SHAPE);
    expect(applied.drift.drifted).toBe(false);
    expect(applied.issues).toEqual([]);
    expect(applied.droppedColumns).toEqual([]);
    expect(applied.mapping.columns).toHaveLength(4);
  });

  it('keeps the transformations that were saved with it', () => {
    const applied = service.applyToSource(template(), SAVED_SHAPE);
    const price = applied.mapping.columns.find((c) => c.header === 'Precio');
    expect(price?.transformations).toEqual([{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }]);
  });
});

describe('a column inserted into the export', () => {
  // The exact failure this design exists to prevent: someone adds a column and
  // every position-bound mapping shifts by one, writing prices into costs.
  const shifted: TemplateShape = {
    headers: ['Nombre', 'Marca', 'SKU', 'Precio', 'Coste'],
    types: ['TEXT', 'TEXT', 'TEXT', 'DECIMAL', 'DECIMAL'],
  };

  it('re-binds by header name, so nothing lands on the wrong column', () => {
    const applied = service.applyToSource(template(), shifted);
    expect(indexFor(applied.mapping, 'SKU')).toBe(2);
    expect(indexFor(applied.mapping, 'Precio')).toBe(3);
    expect(indexFor(applied.mapping, 'Coste')).toBe(4);
    // And crucially, price is still price.
    expect(fieldFor(applied.mapping, 'Precio')).toBe('price');
    expect(fieldFor(applied.mapping, 'Coste')).toBe('cost');
  });

  it('surfaces the new column as an unmapped decision, not as silence', () => {
    const applied = service.applyToSource(template(), shifted);
    const added = applied.mapping.columns.find((c) => c.header === 'Marca');
    expect(added).toMatchObject({ columnIndex: 1, field: null });
    expect(added?.reasons?.[0]).toMatch(/new since the saved mapping/);
  });

  it('says so, but only informationally — nothing is at risk', () => {
    const applied = service.applyToSource(template(), shifted);
    const finding = applied.issues.find((i) => i.message.includes('did not cover'));
    expect(finding?.severity).toBe('INFORMATIONAL');
  });
});

describe('a column removed from the export', () => {
  const missing: TemplateShape = {
    headers: ['Nombre', 'SKU', 'Precio'],
    types: ['TEXT', 'TEXT', 'DECIMAL'],
  };

  it('drops the mapping rather than binding it to whatever is at that position', () => {
    const applied = service.applyToSource(template(), missing);
    expect(applied.droppedColumns).toEqual(['Coste']);
    expect(applied.mapping.columns.some((c) => c.field === 'cost')).toBe(false);
  });

  it('WARNS, because a field the mapping covered would silently vanish', () => {
    const applied = service.applyToSource(template(), missing);
    const finding = applied.issues.find((i) => i.message.includes('does not have'));
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.message).toContain('"Coste"');
    expect(finding?.guidance).toMatch(/will not be imported/);
  });
});

describe('a column that changed what it holds', () => {
  // The subtle one. The mapping still "works" and produces wrong values.
  const retyped: TemplateShape = {
    headers: ['Nombre', 'SKU', 'Precio', 'Coste'],
    types: ['TEXT', 'TEXT', 'TEXT', 'DECIMAL'],
  };

  it('warns by name about the column whose content changed', () => {
    const applied = service.applyToSource(template(), retyped);
    const finding = applied.issues.find((i) => i.anchor?.column === 'precio');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.message).toMatch(/held DECIMAL values .* now holds TEXT/);
    expect(finding?.guidance).toMatch(/transformations on this column/);
  });

  it('still applies the mapping, since refusing would make templates useless', () => {
    const applied = service.applyToSource(template(), retyped);
    expect(fieldFor(applied.mapping, 'Precio')).toBe('price');
  });
});

describe('columns merely reordered', () => {
  const reordered: TemplateShape = {
    headers: ['Precio', 'Nombre', 'Coste', 'SKU'],
    types: ['DECIMAL', 'TEXT', 'DECIMAL', 'TEXT'],
  };

  it('follows the names, so every field stays on its own column', () => {
    const applied = service.applyToSource(template(), reordered);
    expect(indexFor(applied.mapping, 'Precio')).toBe(0);
    expect(indexFor(applied.mapping, 'Nombre')).toBe(1);
    expect(fieldFor(applied.mapping, 'Precio')).toBe('price');
    expect(fieldFor(applied.mapping, 'Nombre')).toBe('name');
  });

  it('says nothing has moved out of place, rather than leaving it ambiguous', () => {
    // Silence here would let someone assume the worst and remap by hand.
    const applied = service.applyToSource(template(), reordered);
    const finding = applied.issues.find((i) => i.message.includes('different order'));
    expect(finding?.severity).toBe('INFORMATIONAL');
    expect(finding?.guidance).toMatch(/follows column names rather than positions/);
  });

  it('returns columns in the file’s order, not the template’s', () => {
    // The editor renders them beside the file, so they must line up with it.
    const applied = service.applyToSource(template(), reordered);
    expect(applied.mapping.columns.map((c) => c.columnIndex)).toEqual([0, 1, 2, 3]);
    expect(applied.mapping.columns.map((c) => c.header)).toEqual(['Precio', 'Nombre', 'Coste', 'SKU']);
  });
});

describe('awkward files', () => {
  it('matches headers case- and whitespace-insensitively', () => {
    // A file exported twice from the same system can differ in casing alone,
    // and failing on that would make templates useless in practice.
    const applied = service.applyToSource(template(), {
      headers: ['  nombre ', 'sku', 'PRECIO', 'Coste'],
      types: SAVED_SHAPE.types,
    });
    expect(applied.droppedColumns).toEqual([]);
    expect(fieldFor(applied.mapping, 'PRECIO')).toBe('price');
  });

  it('binds a duplicated header to its FIRST occurrence', () => {
    // Picking the later one would be arbitrary. The duplicate is reported
    // separately by the mapping validator.
    const applied = service.applyToSource(template(), {
      headers: ['Nombre', 'SKU', 'Precio', 'Precio', 'Coste'],
      types: ['TEXT', 'TEXT', 'DECIMAL', 'DECIMAL', 'DECIMAL'],
    });
    expect(indexFor(applied.mapping, 'Precio')).toBe(2);
  });

  it('handles a file sharing no columns at all with the template', () => {
    const applied = service.applyToSource(template(), {
      headers: ['Referencia', 'Descripción'],
      types: ['TEXT', 'TEXT'],
    });
    expect(applied.droppedColumns).toHaveLength(4);
    // Everything present is offered as an undecided column rather than lost.
    expect(applied.mapping.columns).toHaveLength(2);
    expect(applied.mapping.columns.every((c) => c.field === null)).toBe(true);
  });

  it('does not mutate the stored template', () => {
    // The stored mapping is shared with the audit trail; rebinding must not
    // rewrite what a past plan referenced.
    const t = template();
    const before = JSON.stringify(t.mapping);
    service.applyToSource(t, { headers: ['Nombre'], types: ['TEXT'] });
    expect(JSON.stringify(t.mapping)).toBe(before);
  });

  it('survives a template saved without a recorded shape', () => {
    // Older rows, or a template written by a migration, must not crash the
    // editor.
    const t = template({ sourceHeaders: null as never });
    expect(() => service.applyToSource(t, SAVED_SHAPE)).not.toThrow();
  });
});

describe('the fingerprint', () => {
  it('is identical for an identical shape', () => {
    expect(fingerprintSourceShape(SAVED_SHAPE.headers, SAVED_SHAPE.types)).toBe(
      fingerprintSourceShape([...SAVED_SHAPE.headers], [...SAVED_SHAPE.types]),
    );
  });

  it('changes when a column is added, removed, retyped or reordered', () => {
    const base = fingerprintSourceShape(SAVED_SHAPE.headers, SAVED_SHAPE.types);
    expect(fingerprintSourceShape([...SAVED_SHAPE.headers, 'Marca'], [...SAVED_SHAPE.types, 'TEXT'])).not.toBe(base);
    expect(fingerprintSourceShape(SAVED_SHAPE.headers.slice(0, 3), SAVED_SHAPE.types.slice(0, 3))).not.toBe(base);
    expect(fingerprintSourceShape(SAVED_SHAPE.headers, ['TEXT', 'TEXT', 'TEXT', 'DECIMAL'])).not.toBe(base);
    expect(
      fingerprintSourceShape(['SKU', 'Nombre', 'Precio', 'Coste'], ['TEXT', 'TEXT', 'DECIMAL', 'DECIMAL']),
    ).not.toBe(base);
  });
});
