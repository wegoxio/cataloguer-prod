import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { StorageService, MAX_IMAGE_BYTES } from '../storage.service';

const mockGetSignedUrl = jest.fn();
const mockPutObjectCommand = jest.fn().mockImplementation((input) => ({ input }));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  PutObjectCommand: jest.fn().mockImplementation(function (this: any, input: unknown) {
    mockPutObjectCommand(input);
    this.input = input;
  }),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

describe('StorageService', () => {
  let service: StorageService;
  let config: Record<string, string | undefined>;

  beforeEach(async () => {
    jest.clearAllMocks();
    config = {
      STORAGE_BUCKET: 'product-images',
      STORAGE_PUBLIC_URL: 'https://cdn.example.com/',
      STORAGE_ACCESS_KEY_ID: 'ak',
      STORAGE_SECRET_ACCESS_KEY: 'sk',
    };
    mockGetSignedUrl.mockResolvedValue('https://bucket.r2.dev/signed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService, { provide: ConfigService, useValue: { get: jest.fn((key: string) => config[key]) } }],
    }).compile();

    service = module.get(StorageService);
  });

  it('reports unconfigured when env vars are missing', async () => {
    config.STORAGE_BUCKET = undefined;
    expect(service.isConfigured).toBe(false);
    await expect(service.createUploadTicket('prod-1', 'webp', 1000)).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects sizes outside 1..MAX_IMAGE_BYTES before signing anything', async () => {
    await expect(service.createUploadTicket('prod-1', 'webp', 0)).rejects.toThrow(BadRequestException);
    await expect(service.createUploadTicket('prod-1', 'webp', MAX_IMAGE_BYTES + 1)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.createUploadTicket('prod-1', 'webp', 12.5)).rejects.toThrow(BadRequestException);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('signs Content-Length and Content-Type into the PUT', async () => {
    const ticket = await service.createUploadTicket('prod-1', 'webp', 1234);

    const commandInput = mockPutObjectCommand.mock.calls[0][0];
    expect(commandInput.Bucket).toBe('product-images');
    expect(commandInput.Key).toMatch(/^products\/prod-1\/[0-9a-f-]+\.webp$/);
    expect(commandInput.ContentLength).toBe(1234);
    expect(commandInput.ContentType).toBe('image/webp');

    expect(ticket.url).toBe('https://bucket.r2.dev/signed');
    expect(ticket.headers).toEqual({ 'Content-Type': 'image/webp', 'Content-Length': '1234' });
    expect(ticket.publicUrl).toMatch(/^https:\/\/cdn\.example\.com\/products\/prod-1\//);
  });

  // #174: unknown extensions are rejected outright — no sanitize-into-shape,
  // no dynamically built content-type, nothing signed
  it('rejects non-whitelisted product image extensions before signing', async () => {
    for (const ext of ['../../evil', 'svg', 'exe', 'pdf', 'mp4', 'web p', '.webp']) {
      await expect(service.createUploadTicket('prod-1', ext, 1000)).rejects.toThrow(BadRequestException);
    }
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('defaults a missing product extension to webp (browser optimizes to WebP)', async () => {
    const ticket = await service.createUploadTicket('prod-1', undefined, 1000);
    expect(ticket.headers['Content-Type']).toBe('image/webp');
  });

  it('signs canonical Content-Types — image/jpeg for jpg, never image/jpg', async () => {
    await service.createUploadTicket('prod-1', 'jpg', 1000);
    expect(mockPutObjectCommand.mock.calls[0][0].ContentType).toBe('image/jpeg');
  });

  describe('asset tickets (#174)', () => {
    it('signs canonical types per kind (mov → video/quicktime, pdf → application/pdf)', async () => {
      await service.createAssetTicket('store-1', 'mov', 1024 * 1024);
      expect(mockPutObjectCommand.mock.calls[0][0].ContentType).toBe('video/quicktime');
      expect(mockPutObjectCommand.mock.calls[0][0].Key).toMatch(/^assets\/store-1\/[0-9a-f-]+\.mov$/);

      await service.createAssetTicket('store-1', 'pdf', 1024);
      expect(mockPutObjectCommand.mock.calls[1][0].ContentType).toBe('application/pdf');
    });

    it('rejects unknown asset extensions instead of minting application/octet-stream', async () => {
      for (const ext of ['bin', 'svg', 'exe', 'html', undefined]) {
        await expect(service.createAssetTicket('store-1', ext, 1024)).rejects.toThrow(BadRequestException);
      }
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('keeps the per-kind size caps (image 600KB, file 10MB, video 50MB)', async () => {
      await expect(service.createAssetTicket('store-1', 'webp', MAX_IMAGE_BYTES + 1)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.createAssetTicket('store-1', 'pdf', 10 * 1024 * 1024 + 1)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.createAssetTicket('store-1', 'mp4', 50 * 1024 * 1024 + 1)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.createAssetTicket('store-1', 'mp4', 50 * 1024 * 1024)).resolves.toBeDefined();
    });
  });

  it('surfaces signing failures as 503', async () => {
    mockGetSignedUrl.mockRejectedValue(new Error('boom'));
    await expect(service.createUploadTicket('prod-1', 'webp', 1000)).rejects.toThrow(ServiceUnavailableException);
  });
});
