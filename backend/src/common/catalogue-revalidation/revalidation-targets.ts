export interface CatalogueRevalidationTarget {
  name: string;
  url: string;
  secret: string;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parse once at boot. Invalid fan-out configuration must never fail silently. */
export function parseRevalidationTargets(raw: string | undefined, production = false): CatalogueRevalidationTarget[] {
  if (!raw) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('CATALOGUE_REVALIDATION_TARGETS must be valid JSON');
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('CATALOGUE_REVALIDATION_TARGETS must contain 1 to 20 targets');
  }

  const names = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}] must be an object`);
    }
    const entry = candidate as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (keys.some((key) => !['name', 'url', 'secret'].includes(key))) {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}] contains an unsupported property`);
    }
    if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name) || entry.name.length > 64) {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}].name must be a lowercase kebab key`);
    }
    if (names.has(entry.name)) throw new Error(`Duplicate revalidation target name: ${entry.name}`);
    names.add(entry.name);

    if (typeof entry.secret !== 'string' || entry.secret.length < 32) {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}].secret must contain at least 32 characters`);
    }

    let url: URL;
    try {
      url = new URL(String(entry.url));
    } catch {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}].url must be an absolute URL`);
    }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(localHttp && !production)) {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}].url must use HTTPS`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(`CATALOGUE_REVALIDATION_TARGETS[${index}].url cannot contain credentials, query or fragment`);
    }

    return { name: entry.name, url: url.toString(), secret: entry.secret };
  });
}
