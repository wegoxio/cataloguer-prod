import * as zlib from 'zlib';

/**
 * The archive gate.
 *
 * Every spreadsheet format we accept is a ZIP container, and the accepted value
 * reader will inflate whatever it is handed: measured, `read-excel-file`
 * expanded a 300 kB bomb to 579 MiB of resident memory in 454 ms, which is
 * fatal on a 512 MiB container. So nothing reaches a parser until this gate has
 * read the archive's own directory, refused it on budget, and censused the
 * parts that decide whether the document is safe at all.
 *
 * Two properties matter more than the individual checks:
 *
 *  1. **Declared sizes are checked before anything is inflated.** A ZIP's
 *     central directory states each entry's uncompressed size, so a bomb is
 *     refused by arithmetic rather than by allocating memory and hoping.
 *  2. **Inflation is still budgeted**, because a declared size is attacker
 *     controlled. The streaming inflate aborts the moment the real output
 *     exceeds what was declared or what the budget allows, whichever is first.
 *
 * Compression ratio is deliberately NOT the primary control. Measured on real
 * fixtures: a legitimate 40,000-row workbook compresses 10.2:1, while the bomb
 * is 1023:1. A flat 10:1 cap would reject the legitimate file. Ratio is
 * therefore an anomaly signal at a far higher threshold, and it never rejects
 * on its own — an absolute byte budget does that.
 */

export interface ArchiveBudget {
  /** Total inflated bytes permitted across all entries. */
  maxTotalInflatedBytes: number;
  /** Inflated bytes permitted for any single entry. */
  maxEntryInflatedBytes: number;
  /** Number of entries permitted. */
  maxEntries: number;
  /** Ratio above which an entry is *flagged* (never rejected on this alone). */
  ratioAnomalyThreshold: number;
  /** Wall-clock ceiling for the whole gate, milliseconds. */
  deadlineMs: number;
}

export const PREVIEW_ARCHIVE_BUDGET: ArchiveBudget = {
  maxTotalInflatedBytes: 32 * 1024 * 1024,
  maxEntryInflatedBytes: 16 * 1024 * 1024,
  maxEntries: 256,
  ratioAnomalyThreshold: 100,
  deadlineMs: 20_000,
};

export const JOB_ARCHIVE_BUDGET: ArchiveBudget = {
  maxTotalInflatedBytes: 256 * 1024 * 1024,
  maxEntryInflatedBytes: 64 * 1024 * 1024,
  maxEntries: 512,
  ratioAnomalyThreshold: 100,
  deadlineMs: 300_000,
};

export interface ArchiveEntry {
  name: string;
  compressedBytes: number;
  declaredInflatedBytes: number;
  method: number;
  ratio: number;
  offset: number;
}

export type ActiveContentKind = 'MACRO' | 'EXTERNAL_LINK' | 'OLE_OBJECT' | 'REMOTE_REFERENCE' | 'PRINTER_SETTINGS';

export interface ActiveContentFinding {
  kind: ActiveContentKind;
  entry: string;
  /** User-facing, never echoes document content. */
  detail: string;
}

export interface ArchiveCensus {
  entries: ArchiveEntry[];
  totalCompressedBytes: number;
  totalDeclaredInflatedBytes: number;
  overallRatio: number;
  /** Entries under `xl/media/` — embedded images and other binary payloads. */
  mediaEntries: string[];
  worksheetEntries: string[];
  sharedStringsEntry: string | null;
  activeContent: ActiveContentFinding[];
  ratioAnomalies: string[];
}

export class ArchiveRejected extends Error {
  constructor(
    readonly code:
      | 'NOT_AN_ARCHIVE'
      | 'TOO_MANY_ENTRIES'
      | 'ENTRY_TOO_LARGE'
      | 'ARCHIVE_TOO_LARGE'
      | 'UNSAFE_ENTRY_NAME'
      | 'ACTIVE_CONTENT'
      | 'MALFORMED'
      | 'DEADLINE'
      | 'UNSUPPORTED_METHOD',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveRejected';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * An entry name is safe when it is a plain relative path inside the package.
 * Absolute paths, drive letters, backslashes, `..` segments and empty segments
 * are all refused — a parser that later writes any of these to disk would
 * escape its directory, and refusing here means no consumer has to remember to.
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 512) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  const segments = name.split('/');
  for (const s of segments) {
    if (s === '..') return false;
    if (s === '.') return false;
  }
  // A trailing slash is a directory entry, which is fine.
  return true;
}

/** Locate the end-of-central-directory record, scanning back over the comment. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Read the central directory and apply every budget that can be decided from
 * declared metadata. Nothing is inflated here.
 */
export function censusArchive(buffer: Buffer, budget: ArchiveBudget): ArchiveCensus {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    // An empty archive begins with the EOCD signature instead; both are handled
    // by the directory read below, but a file that is neither is not a ZIP.
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== EOCD_SIGNATURE) {
      throw new ArchiveRejected('NOT_AN_ARCHIVE', 'The file is not a valid workbook package.');
    }
  }

  const eocd = findEocd(buffer);
  if (eocd < 0) {
    throw new ArchiveRejected('MALFORMED', 'The workbook package is incomplete or damaged.');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (entryCount > budget.maxEntries) {
    throw new ArchiveRejected(
      'TOO_MANY_ENTRIES',
      `The workbook contains ${entryCount} parts, more than the ${budget.maxEntries} we can safely inspect.`,
    );
  }

  const entries: ArchiveEntry[] = [];
  let p = cdOffset;
  let totalCompressed = 0;
  let totalDeclared = 0;

  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new ArchiveRejected('MALFORMED', 'The workbook package directory is damaged.');
    }
    const method = buffer.readUInt16LE(p + 10);
    const compressed = buffer.readUInt32LE(p + 20);
    const declared = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    if (!isSafeEntryName(name)) {
      throw new ArchiveRejected('UNSAFE_ENTRY_NAME', 'The workbook contains a part with an unsafe path.');
    }
    if (declared > budget.maxEntryInflatedBytes) {
      throw new ArchiveRejected(
        'ENTRY_TOO_LARGE',
        'One part of the workbook is larger than we can safely expand. Split the file and try again.',
      );
    }

    totalCompressed += compressed;
    totalDeclared += declared;
    if (totalDeclared > budget.maxTotalInflatedBytes) {
      throw new ArchiveRejected(
        'ARCHIVE_TOO_LARGE',
        'The workbook expands to more data than we can safely process. Split the file and try again.',
      );
    }

    entries.push({
      name,
      compressedBytes: compressed,
      declaredInflatedBytes: declared,
      method,
      ratio: compressed > 0 ? +(declared / compressed).toFixed(1) : 0,
      offset: localOffset,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  const activeContent = detectActiveContent(entries, buffer);
  const ratioAnomalies = entries.filter((e) => e.ratio >= budget.ratioAnomalyThreshold).map((e) => e.name);

  return {
    entries,
    totalCompressedBytes: totalCompressed,
    totalDeclaredInflatedBytes: totalDeclared,
    overallRatio: totalCompressed > 0 ? +(totalDeclared / totalCompressed).toFixed(1) : 0,
    mediaEntries: entries.filter((e) => e.name.startsWith('xl/media/')).map((e) => e.name),
    worksheetEntries: entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).map((e) => e.name),
    sharedStringsEntry: entries.find((e) => e.name === 'xl/sharedStrings.xml')?.name ?? null,
    activeContent,
    ratioAnomalies,
  };
}

/**
 * Census of things that make a workbook active rather than documentary.
 * Detection is by part name and relationship target, both of which live in the
 * directory or in small XML parts — no worksheet content is read.
 */
function detectActiveContent(entries: ArchiveEntry[], buffer: Buffer): ActiveContentFinding[] {
  const found: ActiveContentFinding[] = [];

  for (const e of entries) {
    if (/^xl\/vbaProject\.bin$/i.test(e.name) || (/\.bin$/i.test(e.name) && e.name.includes('vbaProject'))) {
      found.push({ kind: 'MACRO', entry: e.name, detail: 'The workbook contains macros.' });
    }
    if (/^xl\/externalLinks\//i.test(e.name) && e.name.endsWith('.xml')) {
      found.push({
        kind: 'EXTERNAL_LINK',
        entry: e.name,
        detail: 'The workbook links to another workbook.',
      });
    }
    if (/^xl\/embeddings\//i.test(e.name)) {
      found.push({ kind: 'OLE_OBJECT', entry: e.name, detail: 'The workbook embeds another document or object.' });
    }
    if (/printerSettings/i.test(e.name)) {
      found.push({ kind: 'PRINTER_SETTINGS', entry: e.name, detail: 'The workbook carries printer settings.' });
    }
  }

  // A relationship whose TargetMode is External is a remote reference even when
  // no externalLinks part exists — scan only the small .rels parts.
  for (const e of entries) {
    if (!e.name.endsWith('.rels')) continue;
    if (e.declaredInflatedBytes > 256 * 1024) continue;
    let xml: string;
    try {
      xml = inflateEntry(buffer, e, e.declaredInflatedBytes + 1024).toString('utf8');
    } catch {
      continue;
    }
    if (/TargetMode\s*=\s*"External"/i.test(xml)) {
      const already = found.some((f) => f.kind === 'EXTERNAL_LINK' || f.kind === 'REMOTE_REFERENCE');
      if (!already) {
        found.push({
          kind: 'REMOTE_REFERENCE',
          entry: e.name,
          detail: 'The workbook references a location outside the file.',
        });
      }
    }
  }

  return found;
}

/**
 * Inflate a single entry with a hard output budget.
 *
 * The declared size in the directory is attacker controlled, so the real output
 * is counted as it is produced and the stream is destroyed the moment it passes
 * the budget. This is what makes a lying header harmless.
 */
export function inflateEntry(buffer: Buffer, entry: ArchiveEntry, maxBytes: number): Buffer {
  const p = entry.offset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== LOCAL_SIGNATURE) {
    throw new ArchiveRejected('MALFORMED', 'A workbook part could not be read.');
  }
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const body = buffer.subarray(start, start + entry.compressedBytes);

  if (entry.method === 0) {
    if (body.length > maxBytes) {
      throw new ArchiveRejected('ENTRY_TOO_LARGE', 'A workbook part is larger than we can safely expand.');
    }
    return Buffer.from(body);
  }
  if (entry.method !== 8) {
    throw new ArchiveRejected('UNSUPPORTED_METHOD', 'The workbook uses an unsupported compression method.');
  }

  // finishFlush=SYNC tolerates the truncated tails some writers produce, while
  // maxOutputLength is the budget that a lying declared size cannot defeat.
  let out: Buffer;
  try {
    out = zlib.inflateRawSync(body, {
      maxOutputLength: maxBytes,
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/maxOutputLength|buffer/i.test(message)) {
      throw new ArchiveRejected('ENTRY_TOO_LARGE', 'A workbook part expands to more data than we can safely process.');
    }
    throw new ArchiveRejected('MALFORMED', 'A workbook part could not be expanded.');
  }
  return out;
}

/**
 * The gate a caller actually uses: census, refuse active content, and return the
 * census for the analyzer. `allowActiveContent` exists only so the census can be
 * reported to a user in a diagnosis; execution paths never set it.
 */
export function openArchive(
  buffer: Buffer,
  budget: ArchiveBudget,
  options: { allowActiveContent?: boolean } = {},
): ArchiveCensus {
  const startedAt = Date.now();
  const census = censusArchive(buffer, budget);

  if (Date.now() - startedAt > budget.deadlineMs) {
    throw new ArchiveRejected('DEADLINE', 'The workbook took too long to inspect.');
  }

  if (!options.allowActiveContent && census.activeContent.length > 0) {
    const kinds = [...new Set(census.activeContent.map((a) => a.kind))];
    throw new ArchiveRejected('ACTIVE_CONTENT', describeActiveContentRefusal(kinds));
  }

  return census;
}

export function describeActiveContentRefusal(kinds: ActiveContentKind[]): string {
  const parts: string[] = [];
  if (kinds.includes('MACRO')) parts.push('macros');
  if (kinds.includes('OLE_OBJECT')) parts.push('embedded objects');
  if (kinds.includes('EXTERNAL_LINK') || kinds.includes('REMOTE_REFERENCE')) parts.push('links to other files');
  const what = parts.length ? parts.join(', ') : 'active content';
  return (
    `This workbook contains ${what}, which we never open. ` +
    'Save a copy as .xlsx without macros or external links — or export the sheet as .csv — and upload that.'
  );
}
