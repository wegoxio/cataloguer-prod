/**
 * Storage URL allow policy (#174).
 *
 * Every image/asset URL a request registers must reference an object of this
 * catalog's own storage. Objects only ever get server-minted keys with exactly
 * two canonical shapes (see StorageService):
 *
 *   products/{productId}/{uuid}.{ext}   — product photos
 *   assets/{storeId|platform}/{uuid}.{ext} — brand assets (bank)
 *
 * The tenant scope is encoded in the key at minting time, so path-scope
 * checks preserve tenant isolation without a lookup. A matching prefix proves
 * the object key was minted under that scope — it does NOT prove an Asset
 * record was registered, which is not required for isolation.
 *
 * Pure functions only (the #172 pattern): configuration is injected by the
 * calling service, never read here, so everything is unit-testable without DI.
 */

export const STORAGE_URL_REJECTION_MESSAGE = 'La URL debe apuntar a un archivo subido a este catálogo';

export const UNSUPPORTED_UPLOAD_TYPE_MESSAGE =
  'Tipo de archivo no admitido: usa imágenes (webp, png, jpg, jpeg, gif), video (mp4, webm, mov, m4v) o PDF';

/** Minting scope used for actors with no store (platform staff). */
export const PLATFORM_SCOPE = 'platform';

export type StorageFileKind = 'image' | 'video' | 'file';

// SVG is deliberately excluded (stored-XSS vector); widening later is additive.
export const IMAGE_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'gif'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'] as const;
export const FILE_EXTENSIONS = ['pdf'] as const;

/**
 * Canonical Content-Type per allowed extension. Signed into presigned PUTs,
 * so the CDN serves exactly these — never a dynamically built `image/${ext}`
 * (which produced the nonstandard image/jpg and let unknown extensions in).
 */
export const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  pdf: 'application/pdf',
};

export function kindOfExtension(extension: string): StorageFileKind | null {
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video';
  if ((FILE_EXTENSIONS as readonly string[]).includes(extension)) return 'file';
  return null;
}

/**
 * Resolves an upload-ticket extension to its canonical Content-Type, or null
 * when the extension is not allowed for the requested kinds. Extensions are
 * matched exactly (lowercased) — never sanitized into something acceptable.
 */
export function resolveUploadContentType(
  extension: string | undefined,
  allowedKinds: readonly StorageFileKind[],
  fallbackExtension?: string,
): { extension: string; contentType: string; kind: StorageFileKind } | null {
  const candidate = (extension ?? fallbackExtension ?? '').toLowerCase();
  if (!/^[a-z0-9]+$/.test(candidate)) return null;
  const kind = kindOfExtension(candidate);
  if (!kind || !allowedKinds.includes(kind)) return null;
  return { extension: candidate, contentType: EXTENSION_CONTENT_TYPES[candidate], kind };
}

export interface ParsedStorageObjectUrl {
  /** Canonical key segments, e.g. ['assets', '<storeId>', '<uuid>.webp']. */
  segments: string[];
  /** Lowercased extension of the final segment. */
  extension: string;
}

/**
 * Parses a candidate URL and returns its object-key segments only when it
 * points inside the configured public storage base. Null means "not ours".
 *
 * Evasion payloads are rejected on the RAW string before WHATWG parsing:
 * the URL parser normalizes backslashes, dot segments and whitespace, so a
 * post-parse check would validate the rewritten URL instead of the attacker's
 * input. Percent-encoding is rejected outright — server-minted keys never
 * contain '%'.
 */
export function parseStorageObjectUrl(rawUrl: unknown, publicBaseUrl: string): ParsedStorageObjectUrl | null {
  // Fail closed: with no configured storage base nothing can be legitimate.
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || !publicBaseUrl) return null;

  if (/[\\%]/.test(rawUrl) || /\s/.test(rawUrl)) return null;
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd < 0) return null;
  const pathStart = rawUrl.indexOf('/', schemeEnd + 3);
  const rawPath = (pathStart >= 0 ? rawUrl.slice(pathStart) : '').split(/[?#]/)[0];
  if (rawPath.includes('//')) return null;
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) return null;

  let url: URL;
  let base: URL;
  try {
    url = new URL(rawUrl);
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }

  // Compare parsed components — never raw startsWith. Hostnames arrive
  // lowercased and IDNA-normalized from the parser, so Unicode lookalikes
  // become distinct punycode and trailing-dot hosts simply don't match.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.protocol !== base.protocol) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname !== base.hostname) return null;
  if (url.port !== base.port) return null;
  // Server-minted URLs carry no query or fragment; their presence is rejection.
  if (url.search !== '' || url.hash !== '') return null;

  const pathname = url.pathname;
  if (!/^[A-Za-z0-9/_.-]+$/.test(pathname)) return null;
  if (pathname.includes('..') || pathname.includes('//')) return null;

  // Path-boundary check against the base path (STORAGE_PUBLIC_URL may carry one).
  const basePath = base.pathname.replace(/\/+$/, '');
  if (!pathname.startsWith(`${basePath}/`)) return null;

  const segments = pathname.slice(basePath.length + 1).split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return null;
  const fileName = segments[segments.length - 1];
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;

  return { segments, extension: fileName.slice(dot + 1).toLowerCase() };
}

/**
 * WHO is attaching the photo, stated explicitly.
 *
 * This replaced `actorStoreId: string | null`, where null meant two
 * incompatible things — "the platform owner, acting globally" and "an
 * organization actor with no branch selected" — and the second one inherited
 * the first one's permission: `ctx.actorStoreId === null` accepted ANY
 * `assets/<store>/…` URL, including another COMPANY's. A store-less manager
 * could therefore make their catalogue depend on a foreign company's library
 * file by pasting its URL, even though no picker offers it and the by-id
 * attachment path refuses it.
 *
 * The same conflation was already shed by `StoreMediaAuthority` (P5-A2 family
 * 2) and `AssetRegistrationAuthority` (family 3). This is the third and last
 * policy to name its authority instead of inferring it from an absent field.
 *
 *   platform     — a genuine unscoped SUPER_ADMIN, and only it. Kept for the
 *                  precedent's sake; in practice a product route always
 *                  resolves a company first, so this case is unreachable
 *                  through the HTTP surface.
 *   organization — an un-narrowed ORGANIZATION_MANAGER, or a SUPER_ADMIN
 *                  acting under a managed organization. Its OWN company's
 *                  banks only: `allowedStoreIds` is every live branch of that
 *                  company, so a sibling branch's file is allowed and another
 *                  company's is not.
 *   store        — an ADMIN, or a manager narrowed to one branch: that
 *                  branch's bank only.
 */
export type ProductImageAuthority =
  | { kind: 'platform' }
  | { kind: 'organization'; allowedStoreIds: string[] }
  | { kind: 'store'; storeId: string };

export interface ProductImageUrlContext {
  productId: string;
  authority: ProductImageAuthority;
}

/**
 * Product photos: the object must belong to the (already tenant-asserted)
 * product, or to a bank the authority above admits.
 *
 * `products/<productId>/…` is unconditional for every authority: those objects
 * are the product's own direct uploads, they carry no library row, and the key
 * already names the product this photo belongs to.
 *
 * The PLATFORM bank (`assets/platform/…`) is reachable only by the unscoped
 * platform owner. An organization actor is refused it, which matches the
 * platform asset — and matches `isAllowedStoreMediaUrl`, where only the owner
 * may name that bank.
 */
export function isAllowedProductImageUrl(rawUrl: unknown, publicBaseUrl: string, ctx: ProductImageUrlContext): boolean {
  const parsed = parseStorageObjectUrl(rawUrl, publicBaseUrl);
  if (!parsed || parsed.segments.length !== 3) return false;
  if (kindOfExtension(parsed.extension) !== 'image') return false;
  const [root, owner] = parsed.segments;
  if (root === 'products') return owner === ctx.productId;
  if (root !== 'assets') return false;

  // Fails closed on shape: an unknown authority kind, a malformed
  // `allowedStoreIds` or an empty target refuses like any other bad URL.
  const authority = ctx?.authority as ProductImageAuthority | undefined;
  if (!authority) return false;
  if (authority.kind === 'platform') return true;

  // Only the platform owner may reach the platform bank.
  if (owner === PLATFORM_SCOPE) return false;

  if (authority.kind === 'organization') {
    const allowed = authority.allowedStoreIds;
    if (!Array.isArray(allowed) || allowed.length === 0) return false;
    if (allowed.some((id) => typeof id !== 'string' || id.length === 0)) return false;
    return allowed.includes(owner);
  }
  if (authority.kind === 'store') {
    const own = authority.storeId;
    return typeof own === 'string' && own.length > 0 && own !== PLATFORM_SCOPE && owner === own;
  }
  return false;
}

/**
 * WHO is registering, stated explicitly (P5-A2 family 3, D-6).
 *
 * This replaced `actorStoreId: string | null`, where null meant both "the
 * platform owner" and "an organization actor with no branch" — the same
 * conflation the store-media policy shed in family 2. Here it was worse than
 * a read: a store-less organization actor could mint and register into the
 * PLATFORM bank.
 *
 *   platform — a genuine unscoped SUPER_ADMIN, and only it
 *   store    — an explicit, scope-validated target branch (every organization
 *              actor, including an un-narrowed manager, names one)
 */

/**
 * Asset-bank registration (D5): strictly the authority's own minting scope — a
 * store target registers only assets/{thatStore}/…, the platform owner only
 * assets/platform/… . The declared type must match the extension class, and an
 * organization actor can never reach the platform bank.
 */

/**
 * WHO is editing, stated explicitly (P5-A2 family 2).
 *
 * This replaced `actorStoreId: string | null`, where null meant two
 * incompatible things: "the platform owner, acting globally" and "an
 * organization actor that simply has no store". Widening
 * ORGANIZATION_MANAGER onto that field would have handed every store-less
 * organization actor the platform branch. Authority is now NAMED — never
 * inferred from an absent field.
 *
 *   platform     — a genuine unscoped SUPER_ADMIN
 *   organization — an un-narrowed ORGANIZATION_MANAGER, or a SUPER_ADMIN
 *                  acting under a managed organization. Organization assets
 *                  and the target store only; the platform bank is NOT theirs.
 *   store        — an ADMIN, or an ORGANIZATION_MANAGER narrowed to a branch
 */

/**
 * Store content images, popup posters and SEO images. Banks are keyed per
 * store (`assets/<storeId>/…`) plus the platform bank, so "within my
 * organization" means "one of the stores my scope allows" — an organization
 * actor can never name a bank outside it, and never the platform bank.
 *
 * Fails closed on shape: an unknown authority kind, a malformed
 * `allowedStoreIds`, or an empty target store rejects like any other bad URL,
 * through the same uniform message (no existence oracle).
 */
