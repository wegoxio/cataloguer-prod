import { BadRequestException } from '@nestjs/common';
import { ProductFieldType } from '../entities/product-field-definition.entity';

/**
 * Key normalization and NUMBER handling for product fields (B4a2).
 *
 * Both are pure functions on purpose: they are the two places where a small
 * inconsistency would quietly corrupt identity or value, so they are testable
 * without a database, a service or a request.
 */

/** Longest key the column accepts. */
const MAX_KEY_LENGTH = 64;

/**
 * Turns a human label into the stable key that IS the field's identity.
 *
 * NFKD first, then combining marks are dropped, so "Café" and "Cafe" cannot
 * become two fields that look identical to a human and different to the
 * database. Everything outside [a-z0-9-] is then discarded.
 *
 * Input that reduces to nothing — a non-Latin-only label, say — is REFUSED
 * rather than replaced with an invented key: a field's identity is permanent,
 * so guessing it once is a mistake that never expires. The caller must supply
 * an explicit ASCII key instead.
 */
export function normalizeFieldKey(raw: string): string {
  const key = (raw ?? '')
    .normalize('NFKD')
    // Combining marks: "é" (e + U+0301) becomes "e".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!key) {
    throw new BadRequestException(
      'This name has no ASCII form, so it cannot become a field key. Supply an explicit key using a-z, 0-9 and hyphens.',
    );
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new BadRequestException(`A field key may be at most ${MAX_KEY_LENGTH} characters`);
  }
  return key;
}

/** numeric(18,6): 18 significant digits, 6 of them fractional. */
const MAX_INTEGER_DIGITS = 12;
const MAX_FRACTION_DIGITS = 6;
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Validates and canonicalizes a NUMBER value.
 *
 * NUMBER travels as a decimal STRING across the API, never as a JavaScript
 * number: numeric(18,6) spans values a double cannot hold exactly, and silently
 * rounding a dimension or a weight is precisely the failure a typed field was
 * meant to prevent.
 *
 * Canonicalization never changes the value — it only removes leading zeros,
 * trailing fractional zeros and a negative zero, so the same quantity written
 * two ways is stored once.
 */
export function canonicalizeDecimal(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('A NUMBER value must be sent as a decimal string');
  }
  const value = raw.trim();
  if (!value) throw new BadRequestException('A NUMBER value cannot be empty');
  // Exponent notation is refused rather than expanded: "1e3" is ambiguous
  // about intended precision, and the column stores a fixed scale.
  if (/[eE]/.test(value)) {
    throw new BadRequestException('A NUMBER value must be plain decimal, without exponent notation');
  }
  if (!PLAIN_DECIMAL.test(value)) {
    throw new BadRequestException('A NUMBER value must be a plain decimal such as "12" or "-3.5"');
  }

  const negative = value.startsWith('-');
  const [intRaw, fracRaw = ''] = value.replace(/^-/, '').split('.');
  const intPart = intRaw.replace(/^0+(?=\d)/, '');
  const fracPart = fracRaw.replace(/0+$/, '');

  if (intPart.length > MAX_INTEGER_DIGITS) {
    throw new BadRequestException(
      `A NUMBER value may have at most ${MAX_INTEGER_DIGITS} digits before the decimal point`,
    );
  }
  // Checked BEFORE trimming zeros would hide it: "1.0000001" must be refused,
  // not silently rounded to "1".
  if (fracRaw.length > MAX_FRACTION_DIGITS) {
    throw new BadRequestException(`A NUMBER value may have at most ${MAX_FRACTION_DIGITS} decimal places`);
  }

  const magnitude = fracPart ? `${intPart}.${fracPart}` : intPart;
  // Negative zero is zero.
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a DATE value: an ISO `YYYY-MM-DD` string naming a real calendar
 * date. No time, no timezone — a delivery window or a design year does not
 * shift with the reader's clock. The UTC round-trip check catches
 * impossible dates ("2026-02-30") that Date silently rolls over.
 */
export function canonicalizeDate(raw: unknown): string {
  if (typeof raw !== 'string' || !ISO_DATE.test(raw.trim())) {
    throw new BadRequestException('A DATE value must be an ISO date string such as "2026-08-05"');
  }
  const value = raw.trim();
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new BadRequestException(`"${value}" is not a real calendar date`);
  }
  return value;
}

/** Longest URL the public contract will carry. */
export const MAX_URL_LENGTH = 2048;

/** Validates a URL value: absolute http(s), bounded length. */
export function canonicalizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BadRequestException('A URL value must be a non-empty string');
  }
  const value = raw.trim();
  if (value.length > MAX_URL_LENGTH) {
    throw new BadRequestException(`A URL value may be at most ${MAX_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('A URL value must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('A URL value must use http or https');
  }
  return value;
}

/** Renders a driver-hydrated date (string or Date) as ISO `YYYY-MM-DD`. */
function isoDateOf(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear().toString().padStart(4, '0');
  const m = (value.getMonth() + 1).toString().padStart(2, '0');
  const d = value.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Reads one value row type-correctly, in the ONE place that knows the rule:
 * TEXT/SELECT/URL are strings, BOOLEAN a real boolean, NUMBER stays a
 * decimal STRING end to end — numeric(18,6) outruns a double — and DATE is
 * an ISO date string (the driver may hydrate a Date; it is normalized here).
 * Null means unanswered. Both the admin values API and the public `fields[]`
 * read through this.
 */
export function readFieldValue(
  type: ProductFieldType,
  row: {
    valueText?: string | null;
    valueNumber?: string | null;
    valueBoolean?: boolean | null;
    valueDate?: string | Date | null;
  },
): string | boolean | null {
  if (type === ProductFieldType.TEXT || type === ProductFieldType.SELECT || type === ProductFieldType.URL) {
    return row.valueText ?? null;
  }
  if (type === ProductFieldType.NUMBER) return row.valueNumber ?? null;
  if (type === ProductFieldType.DATE) {
    return row.valueDate === null || row.valueDate === undefined ? null : isoDateOf(row.valueDate);
  }
  return row.valueBoolean ?? null;
}
