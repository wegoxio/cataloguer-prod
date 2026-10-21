import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  BULK_MAX_IDS,
  BulkArchiveRestoreDto,
  BulkStatusDto,
  BulkCategoryDto,
  BulkInventoryDto,
  BulkPricingDto,
  BulkStoresDto,
  BulkBranchPublicationDto,
} from '../dto/bulk-products.dto';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

/**
 * NO BULK REQUEST MAY BE UNBOUNDED.
 *
 * Each of these walks its ids one at a time inside a single HTTP request, so
 * an unbounded array is a request whose outcome cannot be reported: it can
 * pass the gateway timeout after writing part of the set. The client sends
 * bounded chunks; this is the boundary that holds when some other client does
 * not. The refusal must name the ceiling, so an operator reading a 400 knows
 * what to do rather than guessing.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i + 1));

const cases: [string, any, Record<string, unknown>][] = [
  ['archive/restore', BulkArchiveRestoreDto, {}],
  ['status', BulkStatusDto, { status: ProductStatus.PUBLISHED }],
  ['category', BulkCategoryDto, { categoryId: uuid(999) }],
  ['inventory', BulkInventoryDto, { stockQuantity: 5 }],
  ['pricing', BulkPricingDto, { price: 10 }],
  ['stores', BulkStoresDto, { storeIds: [uuid(998)] }],
  ['branch publication', BulkBranchPublicationDto, { storeId: uuid(997), published: true }],
];

describe.each(cases)('%s accepts at most the ceiling', (_name, Dto, rest) => {
  it(`accepts exactly ${BULK_MAX_IDS} ids`, async () => {
    const dto = plainToInstance(Dto, { ids: ids(BULK_MAX_IDS), ...rest });
    const errors = await validate(dto as object);
    expect(errors.filter((e) => e.property === 'ids')).toEqual([]);
  });

  it(`refuses ${BULK_MAX_IDS + 1} ids, and says the ceiling`, async () => {
    const dto = plainToInstance(Dto, { ids: ids(BULK_MAX_IDS + 1), ...rest });
    const errors = await validate(dto as object);
    const onIds = errors.find((e) => e.property === 'ids');
    expect(onIds).toBeDefined();
    expect(onIds!.constraints).toHaveProperty('arrayMaxSize');
    expect(JSON.stringify(onIds!.constraints)).toContain(String(BULK_MAX_IDS));
  });
});

it('every bulk id array shares one ceiling, so no route is quietly unbounded', () => {
  expect(BULK_MAX_IDS).toBe(1000);
});
