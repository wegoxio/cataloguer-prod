import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const MAX_REDIS_URL_LENGTH = 512;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * True if the string contains any ASCII whitespace or C0/DEL control character.
 * Checked BEFORE new URL() because the URL parser silently strips tabs/newlines
 * (e.g. "rediss://h\n:1" parses to host "h"), which would otherwise let a
 * malformed value through. A codepoint scan avoids embedding control literals.
 */
function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // <= 0x20 covers space and all C0 control chars (tab, LF, CR, ...); 0x7f is DEL.
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates REDIS_URL (#181) by parsing it with the WHATWG URL parser, never by
 * regex alone. Rules:
 *  - protocol is exactly redis: or rediss:
 *  - hostname is non-empty
 *  - no whitespace/control characters anywhere in the value
 *  - a non-loopback host MUST use TLS (rediss:); plaintext redis: is allowed
 *    only for a loopback host, i.e. the disposable local acceptance test
 *  - bounded total length
 *
 * The rejected value is never included in the message — it carries credentials.
 */
@ValidatorConstraint({ name: 'isRedisUrl', async: false })
export class IsRedisUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > MAX_REDIS_URL_LENGTH) return false;
    if (hasWhitespaceOrControl(value)) return false;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }

    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return false;
    if (!url.hostname) return false;

    const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol === 'redis:' && !isLoopback) return false;

    return true;
  }

  defaultMessage(): string {
    // Deliberately excludes the value (which contains credentials).
    return 'REDIS_URL must be a redis:// (loopback only) or rediss:// URL with a valid host';
  }
}

export function IsRedisUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRedisUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsRedisUrlConstraint,
    });
  };
}
