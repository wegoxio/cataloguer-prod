import { clientRequestIdOf, requestIdMiddleware, requestIdOf } from './request-id';

const run = (headers: Record<string, unknown> = {}) => {
  const req = { headers } as never;
  const set: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => void (set[k] = v) } as never;
  let called = false;
  requestIdMiddleware(req, res, () => void (called = true));
  return { req: req as { requestId?: string }, set, called };
};

describe('request identity at the door', () => {
  it('mints an id, pins it on the request and echoes it in the response', () => {
    const { req, set, called } = run();
    expect(called).toBe(true);
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(set['X-Request-Id']).toBe(req.requestId);
  });

  it('keeps a well-formed inbound X-Request-Id as the CLIENT id, beside a freshly minted server id', () => {
    const { req, set } = run({ 'x-request-id': 'caller-trace_0042.a' });
    // Provenance stays distinguishable: the caller cannot choose the id the
    // record is attributed under, and the response echoes the minted one.
    expect((req as { clientRequestId?: string | null }).clientRequestId).toBe('caller-trace_0042.a');
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.requestId).not.toBe('caller-trace_0042.a');
    expect(set['X-Request-Id']).toBe(req.requestId);
    expect(clientRequestIdOf(req)).toBe('caller-trace_0042.a');
  });

  it('replaces an inbound id that could carry log injection or unbounded text', () => {
    // Newlines are the classic log-forgery vector; length keeps queries sane.
    for (const hostile of ['evil\ninjected=true', 'x'.repeat(200), 'short', '{"json":1}', '']) {
      const { req } = run({ 'x-request-id': hostile });
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(clientRequestIdOf(req)).toBeNull();
    }
  });

  it('reads back the pinned id, and says "unknown" rather than inventing one', () => {
    const { req } = run();
    expect(requestIdOf(req)).toBe(req.requestId);
    expect(requestIdOf({})).toBe('unknown');
    expect(requestIdOf(undefined)).toBe('unknown');
  });
});
