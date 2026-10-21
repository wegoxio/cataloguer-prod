import { SUPPORTED_TRANSFORMATIONS, TransformationKind } from '../transform/transformations';

/**
 * What the wizard's editor is allowed to offer, described by the server.
 *
 * Phase 8 left the frontend rendering choices from its own fixture constants,
 * which meant a deployment could support an operation the UI never showed, or —
 * far worse — the UI could offer one the backend would refuse at execution
 * time, after the person had built a whole mapping around it. The list of
 * operations belongs to the code that executes them, so it is served.
 *
 * The version travels with it. A tab left open across a deploy can compare what
 * it holds against what the server now says and tell the person to reload,
 * rather than submitting a mapping the new build cannot run.
 */

/**
 * Bump when a transformation is added, removed, or its options change meaning.
 *
 * Not on cosmetic label edits: a version that changes for a typo fix trains
 * people to ignore the reload prompt.
 */
export const WIZARD_CONTRACT_VERSION = '1.0.0';

export type OptionType = 'TEXT' | 'NUMBER' | 'CHOICE' | 'KEY_VALUE' | 'BOOLEAN';

export interface OptionSpec {
  name: string;
  type: OptionType;
  label: string;
  /** Offered values for CHOICE, with the label shown for each. */
  choices?: { value: string; label: string }[];
  default?: string | number | boolean;
  required?: boolean;
  help?: string;
}

export interface TransformationSpec {
  kind: TransformationKind;
  label: string;
  /** One sentence, written for the person mapping a file, not for a developer. */
  description: string;
  /** Grouping for the editor's menu. */
  group: 'TEXT' | 'NUMBER' | 'DATE' | 'LIST' | 'VALUE';
  options: OptionSpec[];
  /** A worked before/after, so the effect is visible without trying it. */
  example: { before: string; after: string };
}

export const TRANSFORMATION_CATALOGUE: TransformationSpec[] = [
  {
    kind: 'TRIM',
    label: 'Remove surrounding spaces',
    description: 'Removes spaces from the start and end of the value.',
    group: 'TEXT',
    options: [],
    example: { before: '  Camiseta  ', after: 'Camiseta' },
  },
  {
    kind: 'COLLAPSE_WHITESPACE',
    label: 'Tidy spacing',
    description: 'Removes surrounding spaces and reduces repeated spaces to one.',
    group: 'TEXT',
    options: [],
    example: { before: 'Camiseta   azul', after: 'Camiseta azul' },
  },
  {
    kind: 'UPPERCASE',
    label: 'Upper case',
    description: 'Converts the whole value to capitals.',
    group: 'TEXT',
    options: [],
    example: { before: 'abc-123', after: 'ABC-123' },
  },
  {
    kind: 'LOWERCASE',
    label: 'Lower case',
    description: 'Converts the whole value to small letters.',
    group: 'TEXT',
    options: [],
    example: { before: 'ABC-123', after: 'abc-123' },
  },
  {
    kind: 'STRIP_CHARACTERS',
    label: 'Remove characters',
    description: 'Deletes every one of the characters you list, wherever it appears.',
    group: 'TEXT',
    options: [
      {
        name: 'characters',
        type: 'TEXT',
        label: 'Characters to remove',
        required: true,
        help: 'Each character is removed individually, not as a phrase.',
      },
    ],
    example: { before: '€19,99', after: '19,99' },
  },
  {
    kind: 'REPLACE_LITERAL',
    label: 'Find and replace',
    description: 'Replaces exact text with something else. The text is matched literally, never as a pattern.',
    group: 'TEXT',
    options: [
      { name: 'search', type: 'TEXT', label: 'Find', required: true },
      { name: 'replacement', type: 'TEXT', label: 'Replace with' },
    ],
    example: { before: 'REF/001', after: 'REF-001' },
  },
  {
    kind: 'PAD_START',
    label: 'Pad to a fixed length',
    description:
      'Adds characters to the front until the value is long enough. Useful for codes that lost leading zeros.',
    group: 'TEXT',
    options: [
      { name: 'length', type: 'NUMBER', label: 'Total length', required: true },
      { name: 'fill', type: 'TEXT', label: 'Character to add', default: '0' },
    ],
    example: { before: '123', after: '00123' },
  },
  {
    kind: 'PARSE_DECIMAL',
    label: 'Read as a number with decimals',
    description: 'Reads a price or measurement, ignoring currency symbols and thousands separators.',
    group: 'NUMBER',
    options: [
      {
        name: 'decimalSeparator',
        type: 'CHOICE',
        label: 'Decimal separator',
        required: true,
        default: ',',
        choices: [
          { value: ',', label: 'Comma — 1.234,50' },
          { value: '.', label: 'Full stop — 1,234.50' },
        ],
        help: 'This must match your file. "2,5" means two and a half with a comma, and twenty-five with a full stop.',
      },
    ],
    example: { before: '1.234,50 €', after: '1234.5' },
  },
  {
    kind: 'PARSE_INTEGER',
    label: 'Read as a whole number',
    description: 'Reads a quantity. A value with decimals is reported rather than rounded.',
    group: 'NUMBER',
    options: [],
    example: { before: '1.234', after: '1234' },
  },
  {
    kind: 'PARSE_BOOLEAN',
    label: 'Read as yes or no',
    description: 'Understands yes/no, sí/no, true/false, 1/0 and X. Any other word is reported rather than guessed.',
    group: 'VALUE',
    options: [],
    example: { before: 'Sí', after: 'yes' },
  },
  {
    kind: 'PARSE_DATE',
    label: 'Read as a date',
    description: 'Reads a date. You must say which order the parts are in, because 03/04 is ambiguous.',
    group: 'DATE',
    options: [
      {
        name: 'order',
        type: 'CHOICE',
        label: 'Order of the parts',
        required: true,
        default: 'DMY',
        choices: [
          { value: 'DMY', label: 'Day, month, year — 03/04/2026 is 3 April' },
          { value: 'MDY', label: 'Month, day, year — 03/04/2026 is 4 March' },
          { value: 'YMD', label: 'Year, month, day — 2026/04/03' },
        ],
      },
    ],
    example: { before: '03/04/2026', after: '2026-04-03' },
  },
  {
    kind: 'SPLIT_LIST',
    label: 'Split into several values',
    description: 'Splits one cell into a list, for columns holding several categories or image links.',
    group: 'LIST',
    options: [{ name: 'separator', type: 'TEXT', label: 'Separator', default: ',', required: true }],
    example: { before: 'Rojo, Azul, Verde', after: 'Rojo · Azul · Verde' },
  },
  {
    kind: 'MAP_VALUES',
    label: 'Translate values',
    description: 'Turns the words in your file into the words the catalogue uses. Matching ignores capitals.',
    group: 'VALUE',
    options: [
      {
        name: 'mapping',
        type: 'KEY_VALUE',
        label: 'Your value → catalogue value',
        required: true,
      },
      {
        name: 'passThroughUnmapped',
        type: 'BOOLEAN',
        label: 'Keep values you have not listed',
        default: false,
        help: 'Off means an unlisted value is reported so you can decide about it.',
      },
    ],
    example: { before: 'Activo', after: 'PUBLISHED' },
  },
  {
    kind: 'DEFAULT_IF_BLANK',
    label: 'Use a value when the cell is empty',
    description: 'Fills empty cells with a value you choose. Cells that already have content are left alone.',
    group: 'VALUE',
    options: [{ name: 'value', type: 'TEXT', label: 'Value to use', required: true }],
    example: { before: '', after: '0' },
  },
];

/**
 * The catalogue and the executable set must not drift apart.
 *
 * An operation the editor offers but the backend cannot run wastes someone's
 * afternoon; one the backend can run but the editor hides is simply invisible.
 * Both are caught here rather than in review.
 */
export function catalogueMatchesImplementation(): { missing: string[]; extra: string[] } {
  const described = new Set(TRANSFORMATION_CATALOGUE.map((t) => t.kind));
  const implemented = new Set<string>(SUPPORTED_TRANSFORMATIONS);
  return {
    missing: [...implemented].filter((k) => !described.has(k as TransformationKind)),
    extra: [...described].filter((k) => !implemented.has(k)),
  };
}
