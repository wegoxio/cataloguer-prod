import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { BulkBranchPublicationDto } from '../dto/bulk-products.dto';

/**
 * The request shape of POST /bulk/products/branch-publication (ADR 029), run
 * through a ValidationPipe configured EXACTLY as `main.ts` configures the
 * global one — whitelist, transform, forbidNonWhitelisted — so what is pinned
 * here is what the deployed route enforces, not a looser local copy.
 */
describe('BulkBranchPublicationDto under the global validation settings', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: BulkBranchPublicationDto, data: '' });
  const messagesOf = async (body: unknown): Promise<string[]> => {
    try {
      await validate(body);
      return [];
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as { message: string[] | string };
      return Array.isArray(response.message) ? response.message : [response.message];
    }
  };

  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const STORE = '22222222-2222-4222-8222-222222222222';
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`);

  it('accepts a well-formed body and yields the typed DTO', async () => {
    const dto = (await validate({ ids: [UUID_A], storeId: STORE, published: true })) as BulkBranchPublicationDto;
    expect(dto).toBeInstanceOf(BulkBranchPublicationDto);
    expect(dto.ids).toEqual([UUID_A]);
    expect(dto.published).toBe(true);
  });

  it('accepts exactly 1,000 ids', async () => {
    await expect(validate({ ids: ids(1000), storeId: STORE, published: false })).resolves.toBeDefined();
  });

  it('refuses an empty ids array', async () => {
    const messages = await messagesOf({ ids: [], storeId: STORE, published: true });
    expect(messages.join(' ')).toMatch(/ids must contain at least 1 elements/);
  });

  it('refuses 1,001 ids', async () => {
    const messages = await messagesOf({ ids: ids(1001), storeId: STORE, published: true });
    expect(messages.join(' ')).toMatch(/ids must contain no more than 1000 elements/);
  });

  it('refuses a product id that is not a UUID', async () => {
    const messages = await messagesOf({ ids: [UUID_A, 'not-a-uuid'], storeId: STORE, published: true });
    expect(messages.join(' ')).toMatch(/each value in ids must be a UUID/);
  });

  it('refuses a storeId that is not a UUID', async () => {
    const messages = await messagesOf({ ids: [UUID_A], storeId: 'elite', published: true });
    expect(messages.join(' ')).toMatch(/storeId must be a UUID/);
  });

  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['null', null],
    ['missing', undefined],
  ])('refuses a non-boolean published (%s)', async (_label, value) => {
    const body: Record<string, unknown> = { ids: [UUID_A], storeId: STORE };
    if (value !== undefined) body.published = value;
    const messages = await messagesOf(body);
    expect(messages.join(' ')).toMatch(/published must be a boolean value/);
  });

  it('refuses extra fields — a branch price or stock can never ride along (forbidNonWhitelisted)', async () => {
    const messages = await messagesOf({
      ids: [UUID_A],
      storeId: STORE,
      published: true,
      price: 12.5,
      stockQuantity: 3,
    });
    expect(messages.join(' ')).toMatch(/property price should not exist/);
    expect(messages.join(' ')).toMatch(/property stockQuantity should not exist/);
  });
});
