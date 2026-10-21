import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * A deterministic object store at the PROVIDER boundary, and nowhere closer.
 *
 * The temptation in an integration test is to substitute the storage SERVICE,
 * which is much easier and proves much less: it skips the S3 client, the
 * request signing, the presigned URL, the headers that were signed into it, and
 * the HTTP round trip — which is to say it skips most of the code that could
 * actually be wrong.
 *
 * So this substitutes the last thing before Cloudflare: a real HTTP server
 * speaking enough of S3's dialect for `@aws-sdk/client-s3` and its presigner to
 * work unchanged. Everything above it in the stack is the real thing.
 *
 * What it deliberately does NOT do is verify signatures. It cannot — it has no
 * access to the signing key — and pretending otherwise would be a fake claiming
 * to prove the one property only the real provider can. That claim belongs to
 * the pre-publication gate against a real bucket, and it is recorded there.
 */
export interface FakeObjectStore {
  /** Point `IMPORT_SOURCE_ENDPOINT` here. Path-style, so `/{bucket}/{key}`. */
  endpoint: string;
  /** Everything currently stored, keyed by `{bucket}/{key}`. */
  objects: Map<string, Buffer>;
  /** Put bytes in directly, for a source registered without a browser upload. */
  put(bucket: string, key: string, body: Buffer | string): void;
  /** Requests seen, so a test can assert the round trip actually happened. */
  requests: { method: string; path: string; contentType: string | null }[];
  close(): Promise<void>;
}

export async function startFakeObjectStore(): Promise<FakeObjectStore> {
  const objects = new Map<string, Buffer>();
  const requests: FakeObjectStore['requests'] = [];

  const server = http.createServer((req, res) => {
    // The path is `/{bucket}/{key...}` because the client is configured with
    // `forcePathStyle`, which is what an endpoint override implies.
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '');
    requests.push({ method: req.method ?? '', path, contentType: req.headers['content-type'] ?? null });

    // CORS, because a browser really does upload straight to the bucket.
    //
    // Not a convenience for the test: the real bucket needs exactly this, and
    // the manifest says so. A browser refuses a cross-origin PUT without it,
    // so a fake that skipped it would let an integration test pass while the
    // configured-for-real path was broken — the one thing this fake exists to
    // stop happening.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'PUT, GET, HEAD');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
      res.setHeader('Access-Control-Max-Age', '3600');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        objects.set(path, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"fake"' });
        res.end();
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const body = objects.get(path);
      if (!body) {
        // The shape the SDK expects for a miss, so the service's own error
        // handling is exercised rather than bypassed.
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>');
        return;
      }
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (req.method === 'DELETE') {
      objects.delete(path);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    put: (bucket, key, body) =>
      objects.set(`${bucket}/${key}`, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
