/**
 * Explicit request-body limits.
 *
 * Until Phase 9 nothing configured a body-parser limit, so every JSON route ran
 * under Express's implicit 100 kB default. That default was invisible and it
 * silently contradicted the importer's own `COMMIT_MAX_ROWS = 500`: measured
 * against the real 45-column DesignHof export, 500 rows serialize to 569 kB and
 * 200 rows to 266 kB, so the 500-row cap was unreachable and the true ceiling
 * was ~76 rows. The frontend's 50-row chunk (69 kB) fit only by luck, with
 * ~31 kB of headroom — a slightly wider file would have produced an opaque 413.
 *
 * Making the limit explicit and naming a chunk size that fits well inside it is
 * what removes the contradiction. The legacy importer keeps a generous but
 * STATED ceiling; the Phase 9 execution API does not need one, because it posts
 * a plan identity and an approval proof rather than hundreds of rows.
 */

/** Default for ordinary JSON routes. Was an implicit Express default; now stated. */
export const DEFAULT_JSON_BODY_LIMIT = '256kb';

/**
 * The legacy `/import/commit` route, which still receives raw rows.
 * 2 MB comfortably holds the 500-row cap the service advertises (569 kB
 * measured) with room for wider sources, so the advertised cap and the
 * transport ceiling finally agree.
 */
export const IMPORT_COMMIT_BODY_LIMIT = '2mb';

/** Bytes, for the guard that rejects before the parser allocates. */
export const IMPORT_COMMIT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Multipart limits for upload routes. Multer previously set only `fileSize` and
 * `files`, leaving `parts`, `fields` and `fieldSize` at Infinity/1 MB — a body
 * of tens of thousands of non-file parts was bounded only by part count.
 */
export const MULTIPART_LIMITS = {
  files: 1,
  /** file + the handful of scalar fields the routes read */
  parts: 16,
  fields: 12,
  fieldSize: 64 * 1024,
  fieldNameSize: 128,
} as const;
