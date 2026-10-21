import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CatalogueRevalidationService } from './catalogue-revalidation.service';

const targets = [
  { name: 'one', url: 'https://one.example/revalidate', secret: '1'.repeat(32) },
  { name: 'two', url: 'https://two.example/revalidate', secret: '2'.repeat(32) },
];

describe('CatalogueRevalidationService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('fans out one signed request per target and collapses a synchronous burst', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const service = new CatalogueRevalidationService(
      new ConfigService({ NODE_ENV: 'production', CATALOGUE_REVALIDATION_TARGETS: JSON.stringify(targets) }),
    );

    service.request();
    service.request();
    await jest.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const target of targets) {
      const call = fetchMock.mock.calls.find(([url]) => url === target.url);
      expect(call).toBeDefined();
      const options = call?.[1] as RequestInit;
      const timestamp = (options.headers as Record<string, string>)['x-cataloguer-timestamp'];
      const expected = createHmac('sha256', target.secret)
        .update(`${timestamp}.${options.body}`)
        .digest('hex');
      expect((options.headers as Record<string, string>)['x-cataloguer-signature']).toBe(`sha256=${expected}`);
    }
  });

  it('runs a second fan-out when another mutation lands during delivery', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(new Response(null, { status: 200 }));
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementationOnce(() => first)
      .mockResolvedValue(new Response(null, { status: 200 }));
    const service = new CatalogueRevalidationService(
      new ConfigService({ NODE_ENV: 'production', CATALOGUE_REVALIDATION_TARGETS: JSON.stringify(targets) }),
    );

    service.request();
    await jest.advanceTimersByTimeAsync(100);
    service.request();
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    await jest.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
