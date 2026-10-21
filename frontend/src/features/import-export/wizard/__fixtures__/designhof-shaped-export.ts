/**
 * The one and only data source of the Phase 8 wizard (decision D3).
 *
 * EVERY number, row and finding on every wizard screen comes from this file.
 * Nothing here is fetched, and nothing here is derived from the user's real
 * catalogue, so the wizard cannot show a client their own products in a flow
 * that will not actually import them — the most damaging way this rehearsal
 * could mislead.
 *
 * Everything is a frozen literal: no `Date.now()`, no `Math.random()`, no
 * counters. A screenshot taken today and one taken next month are identical,
 * which is what makes the wizard reviewable and its tests stable.
 *
 * The fixture is deliberately UNTIDY — a missing price, an unreachable image,
 * a duplicate SKU, a category that does not exist yet. A rehearsal over clean
 * data proves nothing about the decisions an operator actually has to make.
 */

export interface FixtureFile {
  name: string;
  sizeLabel: string;
  rowCount: number;
  columnCount: number;
  encoding: string;
  delimiter: string;
  /** Stable digest shown so two inspections of "the same file" are comparable. */
  checksum: string;
}

export interface FixtureColumn {
  index: number;
  header: string;
  detectedType: 'text' | 'number' | 'money' | 'url' | 'list';
  blankCount: number;
  samples: string[];
}

export interface TargetField {
  key: string;
  label: string;
  required: boolean;
  hint: string;
}

export interface FamilyProposal {
  id: string;
  modelName: string;
  memberRows: number[];
  memberLabels: string[];
  /** 0..1. Rendered as a percentage; never rounded up to hide doubt. */
  confidence: number;
  reasons: string[];
  caveat: string | null;
}

export interface SpecificationProposal {
  id: string;
  name: string;
  dataType: 'TEXT' | 'NUMBER' | 'SELECT' | 'DATE' | 'URL';
  unit: string | null;
  origin: 'registry' | 'new';
  sampleValues: string[];
  note: string;
}

export interface CategoryProposal {
  id: string;
  path: string;
  origin: 'existing' | 'new';
  productCount: number;
  note: string;
}

export interface AssetFinding {
  id: string;
  reference: string;
  kind: 'image' | 'document';
  status: 'reachable' | 'unreachable' | 'duplicate';
  detail: string;
}

export interface StoreTarget {
  id: string;
  name: string;
  organization: string;
  defaultSelected: boolean;
  note: string;
}

export type FindingSeverity = 'blocking' | 'warning' | 'info';

export interface ValidationFinding {
  id: string;
  severity: FindingSeverity;
  /** 1-based row in the source file, or null for a whole-file finding. */
  row: number | null;
  column: string | null;
  message: string;
  remedy: string;
}

export interface ProgressStage {
  id: string;
  label: string;
  rows: number;
  outcome: 'completed' | 'partial' | 'not-started';
  detail: string;
}

export interface ReportLine {
  id: string;
  label: string;
  value: string;
}

export interface RetryCandidate {
  id: string;
  rows: number[];
  reason: string;
  fix: string;
}

export interface RecoveryPoint {
  id: string;
  label: string;
  covers: string;
  /** Fixed ISO instant — a rehearsal must not look like it happened just now. */
  takenAt: string;
}

export const FIXTURE_FILE: FixtureFile = {
  name: 'proveedor-mobiliario-2026-03.csv',
  sizeLabel: '184 KB',
  rowCount: 240,
  columnCount: 11,
  encoding: 'UTF-8',
  delimiter: ',',
  checksum: 'sha256:4f1c…9ab2',
};

export const FIXTURE_COLUMNS: FixtureColumn[] = [
  { index: 0, header: 'Referencia', detectedType: 'text', blankCount: 0, samples: ['NRD-CH-001', 'NRD-CH-002', 'OSL-TB-010'] },
  { index: 1, header: 'Nombre', detectedType: 'text', blankCount: 0, samples: ['Silla Nordic verde', 'Silla Nordic azul', 'Mesa Oslo'] },
  { index: 2, header: 'Precio', detectedType: 'money', blankCount: 3, samples: ['129,90', '129,90', '349,00'] },
  { index: 3, header: 'Precio oferta', detectedType: 'money', blankCount: 187, samples: ['', '99,90', ''] },
  { index: 4, header: 'Stock', detectedType: 'number', blankCount: 0, samples: ['12', '4', '0'] },
  { index: 5, header: 'Categoria', detectedType: 'text', blankCount: 6, samples: ['Sillas', 'Sillas', 'Mesas / Comedor'] },
  { index: 6, header: 'Color', detectedType: 'text', blankCount: 41, samples: ['Verde', 'Azul', 'Roble'] },
  { index: 7, header: 'Material', detectedType: 'text', blankCount: 12, samples: ['Roble macizo', 'Roble macizo', 'Roble macizo'] },
  { index: 8, header: 'Ancho (cm)', detectedType: 'number', blankCount: 20, samples: ['46', '46', '160'] },
  { index: 9, header: 'Fotos', detectedType: 'list', blankCount: 9, samples: ['https://cdn…/nrd-1.jpg', 'https://cdn…/nrd-2.jpg', ''] },
  { index: 10, header: 'Ficha tecnica', detectedType: 'url', blankCount: 201, samples: ['', 'https://cdn…/nrd.pdf', ''] },
];

/**
 * Where a column can be sent. `required` drives the blocking findings in the
 * validation step, so the two screens cannot disagree about what is mandatory.
 */
export const TARGET_FIELDS: TargetField[] = [
  { key: 'sku', label: 'Reference (SKU)', required: true, hint: 'Identifies the product across imports.' },
  { key: 'name', label: 'Name', required: true, hint: 'Shown to shoppers.' },
  { key: 'price', label: 'Price', required: true, hint: 'Decimal separator is declared once, for the whole file.' },
  { key: 'salePrice', label: 'Sale price', required: false, hint: 'Left empty means no offer.' },
  { key: 'stock', label: 'Stock', required: false, hint: 'Only for products that track inventory.' },
  { key: 'category', label: 'Category', required: false, hint: 'A path such as "Mesas / Comedor" creates the tree.' },
  { key: 'images', label: 'Photos', required: false, hint: 'Web addresses, separated by a space.' },
  { key: 'documents', label: 'Documents', required: false, hint: 'Data sheets and manuals.' },
];

/** The mapping the wizard opens with, so an operator edits rather than starts blank. */
export const SUGGESTED_MAPPING: Record<string, number | null> = {
  sku: 0,
  name: 1,
  price: 2,
  salePrice: 3,
  stock: 4,
  category: 5,
  images: 9,
  documents: null,
};

export const FAMILY_PROPOSALS: FamilyProposal[] = [
  {
    id: 'fam-nordic-chair',
    modelName: 'Silla Nordic',
    memberRows: [1, 2, 3, 4],
    memberLabels: ['Verde', 'Azul', 'Gris', 'Negro'],
    confidence: 0.94,
    reasons: [
      'Four references share the prefix NRD-CH.',
      'Names differ only by the value in "Color".',
      'Price and material are identical across all four rows.',
    ],
    caveat: null,
  },
  {
    id: 'fam-oslo-table',
    modelName: 'Mesa Oslo',
    memberRows: [10, 11],
    memberLabels: ['160 cm', '200 cm'],
    confidence: 0.72,
    reasons: [
      'Two references share the prefix OSL-TB.',
      'Names differ only by the value in "Ancho (cm)".',
    ],
    caveat: 'Prices differ by 90,00 — a size difference, or two different products.',
  },
  {
    id: 'fam-lamp-cluster',
    modelName: 'Lámpara Bergen',
    memberRows: [55, 56, 57],
    memberLabels: ['Blanca', 'Negra', 'Latón'],
    confidence: 0.38,
    reasons: ['Names share the first word "Lámpara".'],
    caveat: 'References share no prefix and materials differ. Low confidence — read the rows before accepting.',
  },
];

export const SPECIFICATION_PROPOSALS: SpecificationProposal[] = [
  {
    id: 'spec-material',
    name: 'Material',
    dataType: 'SELECT',
    unit: null,
    origin: 'registry',
    sampleValues: ['Roble macizo', 'Nogal', 'Metal'],
    note: 'Already defined for this company. Values map onto the existing options.',
  },
  {
    id: 'spec-width',
    name: 'Width',
    dataType: 'NUMBER',
    unit: 'cm',
    origin: 'registry',
    sampleValues: ['46', '160', '200'],
    note: 'Already defined. The unit comes from the registry, not from the column header.',
  },
  {
    id: 'spec-colour',
    name: 'Colour',
    dataType: 'SELECT',
    unit: null,
    origin: 'new',
    sampleValues: ['Verde', 'Azul', 'Gris', 'Negro', 'Roble'],
    note: 'Not defined yet. Accepting adds it to the company registry with these five options.',
  },
];

export const CATEGORY_PROPOSALS: CategoryProposal[] = [
  { id: 'cat-sillas', path: 'Sillas', origin: 'existing', productCount: 96, note: 'Matched by name, exactly.' },
  { id: 'cat-mesas', path: 'Mesas', origin: 'existing', productCount: 41, note: 'Parent of the path below.' },
  { id: 'cat-mesas-comedor', path: 'Mesas / Comedor', origin: 'new', productCount: 28, note: 'Would be created under the existing "Mesas".' },
  { id: 'cat-unassigned', path: '(no category)', origin: 'existing', productCount: 6, note: 'Six rows leave "Categoria" empty.' },
];

export const ASSET_FINDINGS: AssetFinding[] = [
  { id: 'asset-ok', reference: '212 photos', kind: 'image', status: 'reachable', detail: 'Answered within the timeout and returned an image.' },
  { id: 'asset-dupe', reference: '18 photos', kind: 'image', status: 'duplicate', detail: 'Identical address used by more than one row; stored once, linked to each.' },
  { id: 'asset-bad', reference: '9 photos', kind: 'image', status: 'unreachable', detail: 'Returned 404. These rows would import without a photo.' },
  { id: 'asset-doc', reference: '39 data sheets', kind: 'document', status: 'reachable', detail: 'PDF documents; attached as documents, never as the main photo.' },
];

export const STORE_TARGETS: StoreTarget[] = [
  { id: 'store-main', name: 'Tienda principal', organization: 'EliteToGo', defaultSelected: true, note: 'The branch this session is scoped to.' },
  { id: 'store-outlet', name: 'Outlet', organization: 'EliteToGo', defaultSelected: false, note: 'Shares the catalogue; stock is tracked separately.' },
  { id: 'store-showroom', name: 'Showroom', organization: 'EliteToGo', defaultSelected: false, note: 'Display only — prices are hidden to shoppers.' },
];

/**
 * The three kinds of finding, and the reason they are three.
 *
 * BLOCKING stops the run; a WARNING is a decision the operator is allowed to
 * make; INFORMATIONAL is neither and must never be counted with the other two,
 * because an operator who learns that "findings" sometimes mean nothing stops
 * reading all of them.
 */
export const VALIDATION_FINDINGS: ValidationFinding[] = [
  {
    id: 'val-price-missing',
    severity: 'blocking',
    row: 74,
    column: 'Precio',
    message: 'Price is empty and Price is a required field.',
    remedy: 'Fill the cell in the file, or map Price to a column that has a value.',
  },
  {
    id: 'val-duplicate-sku',
    severity: 'blocking',
    row: 118,
    column: 'Referencia',
    message: 'Reference NRD-CH-002 appears twice in this file, with different prices.',
    remedy: 'Decide which row is correct and remove the other before importing.',
  },
  {
    id: 'val-decimal',
    severity: 'blocking',
    row: null,
    column: 'Precio',
    message: 'Two decimal separators are used in the same column (129,90 and 349.00).',
    remedy: 'Normalise the column, then declare the separator once on the mapping step.',
  },
  {
    id: 'val-image-404',
    severity: 'warning',
    row: 31,
    column: 'Fotos',
    message: 'Nine photo addresses did not answer. Those rows would import without a photo.',
    remedy: 'Import anyway and add photos later, or fix the addresses first.',
  },
  {
    id: 'val-category-blank',
    severity: 'warning',
    row: null,
    column: 'Categoria',
    message: 'Six rows have no category and would not appear under any menu.',
    remedy: 'Leave as is, or set a fallback category on the categories step.',
  },
  {
    id: 'val-low-confidence-family',
    severity: 'warning',
    row: null,
    column: null,
    message: 'One family proposal is below 50% confidence and is not accepted by default.',
    remedy: 'Review "Lámpara Bergen" on the families step.',
  },
  {
    id: 'val-new-spec',
    severity: 'info',
    row: null,
    column: 'Color',
    message: 'Accepting the Colour specification would add one entry to the company registry.',
    remedy: 'No action needed. Stated so the registry does not grow unnoticed.',
  },
  {
    id: 'val-currency',
    severity: 'info',
    row: null,
    column: 'Precio',
    message: 'Prices are read in the company currency (EUR). No conversion is applied.',
    remedy: 'No action needed.',
  },
];

/**
 * A RECORDED shape, not a running job. There is no timer behind this: the
 * wizard shows what the stages of a real run would be, with the counts a run
 * over this fixture would produce, and says plainly that none of it ran.
 */
export const PROGRESS_STAGES: ProgressStage[] = [
  { id: 'prog-read', label: 'Read and parse the file', rows: 240, outcome: 'completed', detail: 'All rows parsed; encoding confirmed as UTF-8.' },
  { id: 'prog-categories', label: 'Create missing categories', rows: 1, outcome: 'completed', detail: '"Mesas / Comedor" created under "Mesas".' },
  { id: 'prog-products', label: 'Write products', rows: 226, outcome: 'partial', detail: '226 of 240 written; 14 held back by the blocking findings.' },
  { id: 'prog-families', label: 'Group variants into models', rows: 6, outcome: 'completed', detail: 'Two accepted proposals; six member rows linked.' },
  { id: 'prog-assets', label: 'Fetch and attach photos', rows: 230, outcome: 'partial', detail: '221 attached, 9 addresses did not answer.' },
  { id: 'prog-stores', label: 'Publish to the selected branches', rows: 226, outcome: 'not-started', detail: 'Never reached — this rehearsal stops before any write.' },
];

export const REPORT_LINES: ReportLine[] = [
  { id: 'rep-rows', label: 'Rows read', value: '240' },
  { id: 'rep-would-create', label: 'Products that WOULD be created', value: '198' },
  { id: 'rep-would-update', label: 'Products that WOULD be updated', value: '28' },
  { id: 'rep-would-skip', label: 'Rows that WOULD be held back', value: '14' },
  { id: 'rep-categories', label: 'Categories that WOULD be created', value: '1' },
  { id: 'rep-specs', label: 'Registry entries that WOULD be added', value: '1' },
  { id: 'rep-actual', label: 'Records actually written', value: '0 — nothing ran' },
];

export const RETRY_CANDIDATES: RetryCandidate[] = [
  {
    id: 'retry-price',
    rows: [74, 91, 140],
    reason: 'Price empty.',
    fix: 'Fill the three cells and re-upload only those rows.',
  },
  {
    id: 'retry-duplicate',
    rows: [118],
    reason: 'Duplicate reference.',
    fix: 'Remove the losing row; the surviving one is imported normally.',
  },
  {
    id: 'retry-images',
    rows: [31, 32, 33, 34, 35, 36, 37, 38, 39],
    reason: 'Photo address did not answer.',
    fix: 'Products already exist after a real run — a retry attaches photos only, it does not duplicate the product.',
  },
];

export const RECOVERY_POINTS: RecoveryPoint[] = [
  {
    id: 'rec-before',
    label: 'Catalogue state before the run',
    covers: 'Products, categories, specifications and store links, as they were at the moment the run was approved.',
    takenAt: '2026-03-14T09:12:00Z',
  },
  {
    id: 'rec-partial',
    label: 'State after the partial run',
    covers: 'What a run interrupted at the products stage would have left behind.',
    takenAt: '2026-03-14T09:19:00Z',
  },
];
