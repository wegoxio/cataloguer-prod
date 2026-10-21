import { BadRequestException } from '@nestjs/common';
import { ALLOWED_CONTROL_CODES, CSV_MIME_ALLOWLIST } from './import-upload.constants';
import { detectFormat } from './content-signature';

/** The subset of a Multer file this validator needs. */
export interface UploadedCsvFile {
  originalname?: string;
  mimetype?: string;
  buffer: Buffer;
}

/**
 * The single gate every CSV import passes through before its parser runs
 * (#172). It validates the file's type and content and returns decoded CSV
 * text; it never invokes Papa Parse — record/row semantics belong to each
 * consuming service. Excel is rejected here with CSV guidance.
 *
 * Errors are user-safe: no filesystem paths, dependency names, or internal
 * limits leak.
 */
export function validateAndDecodeCsv(file: UploadedCsvFile): string {
  if (!file?.buffer || file.buffer.length === 0) {
    throw new BadRequestException('El archivo está vacío o no se recibió.');
  }

  const name = (file.originalname ?? '').toLowerCase().trim();
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot) : '';

  // Excel is temporarily unavailable — guide the user to CSV (no CVE/dep detail)
  if (extension === '.xls' || extension === '.xlsx') {
    throw new BadRequestException(
      'La importación de Excel no está disponible por ahora. Exporta el archivo como CSV e inténtalo de nuevo.',
    );
  }
  if (extension !== '.csv') {
    throw new BadRequestException('Solo se admiten archivos CSV (.csv).');
  }

  // Declared MIME is advisory (client-supplied); it narrows, never authorizes
  const mimetype = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (mimetype && !CSV_MIME_ALLOWLIST.includes(mimetype)) {
    throw new BadRequestException('El tipo de archivo no corresponde a un CSV válido.');
  }

  // Content signature decides what the bytes ARE. The extension and the declared
  // MIME above are both client-supplied — and `application/octet-stream` is
  // allow-listed — so neither can be the gate. A ZIP, OLE2 document, PDF or
  // image renamed `.csv` is refused here, before any decoding.
  //
  // Only POSITIVELY identified containers are refused here. `UNKNOWN_BINARY`
  // deliberately falls through to the UTF-8 and control-byte checks below,
  // which diagnose byte-level problems more precisely than "wrong container"
  // would.
  const detected = detectFormat(file.buffer);
  if (detected !== 'CSV_OR_TEXT' && detected !== 'UNKNOWN_BINARY') {
    throw new BadRequestException('El contenido del archivo no es texto CSV, aunque su nombre lo indique.');
  }

  // Strict UTF-8: fatal decoding rejects invalid byte sequences deterministically
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  } catch {
    throw new BadRequestException('El archivo no es texto UTF-8 válido.');
  }

  // Strip a single leading UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Reject NUL and any C0 control other than tab/LF/CR — the mark of binary
  // content disguised as CSV. Explicit and deterministic, not a heuristic ratio.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && !ALLOWED_CONTROL_CODES.has(code)) {
      throw new BadRequestException('El archivo contiene datos binarios y no es un CSV de texto.');
    }
  }

  return text;
}
