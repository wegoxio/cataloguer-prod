/**
 * Content-signature detection for uploaded documents.
 *
 * Until Phase 9 the only gate was the filename extension plus an advisory MIME
 * header — and `application/octet-stream` was allow-listed while an absent
 * mimetype skipped the check entirely, so declared-type filtering was
 * effectively opt-out by the client. This module decides what a file *is* from
 * its bytes, and the caller then refuses any disagreement with what it claims
 * to be.
 *
 * Scope note: this identifies containers, not intent. A ZIP that is really an
 * XLSX still has to survive the archive gate before any parser sees it, and a
 * text file still has to survive UTF-8 and control-byte validation. Signature
 * detection removes the "trust the name" step; it does not replace either.
 */

export type DetectedFormat =
  | 'CSV_OR_TEXT'
  | 'ZIP_CONTAINER' // xlsx / ods / any OOXML or ODF package
  | 'OLE2' // legacy .xls / .doc — refused by decision D
  | 'PDF'
  | 'IMAGE'
  | 'UNKNOWN_BINARY';

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean => {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
};

/** Local file header, empty archive, or spanned archive. */
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

/** Compound File Binary Format — what a real legacy .xls actually is. */
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const IMAGE_SIGNATURES: Array<{ bytes: number[]; offset?: number }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (WEBP)
];

/**
 * Decide the container from the leading bytes.
 *
 * Text is the residual case on purpose: CSV has no signature, so anything that
 * is not a recognized binary container and decodes as text is treated as text
 * and handed to the existing UTF-8/control-byte validator, which is stricter
 * than any heuristic we could add here.
 */
export function detectFormat(buffer: Buffer): DetectedFormat {
  if (buffer.length === 0) return 'UNKNOWN_BINARY';

  for (const sig of ZIP_SIGNATURES) if (startsWith(buffer, sig)) return 'ZIP_CONTAINER';
  if (startsWith(buffer, OLE2_SIGNATURE)) return 'OLE2';
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'PDF'; // %PDF
  for (const img of IMAGE_SIGNATURES) if (startsWith(buffer, img.bytes, img.offset ?? 0)) return 'IMAGE';

  // A UTF-8 BOM is a positive text signal; otherwise fall through to the
  // control-byte scan, which is what actually separates text from binary.
  if (startsWith(buffer, [0xef, 0xbb, 0xbf])) return 'CSV_OR_TEXT';

  // NUL in the first block is the classic binary tell; real CSV never has one.
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (window.includes(0x00)) return 'UNKNOWN_BINARY';

  return 'CSV_OR_TEXT';
}

/** Extensions we accept, mapped to the container their bytes must show. */
export const EXTENSION_EXPECTATIONS: Record<string, DetectedFormat[]> = {
  '.csv': ['CSV_OR_TEXT'],
  '.tsv': ['CSV_OR_TEXT'],
  '.txt': ['CSV_OR_TEXT'],
  '.xlsx': ['ZIP_CONTAINER'],
  '.xlsm': ['ZIP_CONTAINER'],
};

export interface SignatureVerdict {
  ok: boolean;
  detected: DetectedFormat;
  /** Operator/user-facing reason; safe to surface verbatim. */
  reason?: string;
}

/**
 * Compare declared extension against detected bytes.
 *
 * `.xls` is refused explicitly rather than falling into a generic "unsupported"
 * message, because the useful thing to tell someone holding a legacy workbook is
 * how to get a supported one (decision D).
 */
export function verifySignature(fileName: string, buffer: Buffer): SignatureVerdict {
  const lower = (fileName || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const detected = detectFormat(buffer);

  if (ext === '.xls') {
    return {
      ok: false,
      detected,
      reason:
        'Legacy .xls workbooks are not supported. Open the file and use “Save as” to export it as .xlsx or .csv, then upload that.',
    };
  }

  const expected = EXTENSION_EXPECTATIONS[ext];
  if (!expected) {
    return {
      ok: false,
      detected,
      reason: `Unsupported file type “${ext || 'unknown'}”. Upload a .csv, .tsv or .xlsx file.`,
    };
  }

  if (!expected.includes(detected)) {
    // Name and content disagree. Say what we actually found, without echoing
    // any file content back to the caller.
    return {
      ok: false,
      detected,
      reason: `The file is named “${ext}” but its contents are ${describe(detected)}. Upload the file in the format its name claims.`,
    };
  }

  return { ok: true, detected };
}

function describe(f: DetectedFormat): string {
  switch (f) {
    case 'ZIP_CONTAINER':
      return 'a compressed workbook or archive';
    case 'OLE2':
      return 'a legacy Microsoft Office binary file';
    case 'PDF':
      return 'a PDF document';
    case 'IMAGE':
      return 'an image';
    case 'CSV_OR_TEXT':
      return 'plain text';
    default:
      return 'unrecognized binary data';
  }
}
