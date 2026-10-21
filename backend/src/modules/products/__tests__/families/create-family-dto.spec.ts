import { ValidationPipe } from '@nestjs/common';
import { CreateFamilyDto } from '../../dto/create-family.dto';

/**
 * The route had NO DTO.
 *
 * Its body was declared as an inline object type, which erases to `Object`,
 * and `ValidationPipe` skips a parameter whose metatype is a native type — so
 * `whitelist`, `forbidNonWhitelisted` and every bound the pipe is configured
 * with were silently not running on `POST /products/families`. Nothing capped
 * a label, nothing required a member id to be a uuid, and an unknown property
 * was accepted and quietly ignored.
 *
 * These cases run the REAL pipe with the REAL configuration from `main.ts`.
 */
describe('CreateFamilyDto — the validation the family routes never had', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const meta = { type: 'body' as const, metatype: CreateFamilyDto, data: '' };
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const valid = {
    name: 'Camiseta',
    members: [
      { id: ID, label: 'S' },
      { id: ID2, label: 'M' },
    ],
  };

  const accept = (body: unknown) => pipe.transform(body, meta);
  const reject = (body: unknown) => expect(pipe.transform(body, meta)).rejects.toThrow();

  it('accepts the exact body PR B sends, unchanged', async () => {
    await expect(accept(valid)).resolves.toMatchObject(valid);
  });

  it('accepts the optional descriptive fields PR C adds', async () => {
    await expect(
      accept({ ...valid, description: 'La ficha', metaTitle: 'T', metaDescription: 'D' }),
    ).resolves.toMatchObject({ description: 'La ficha' });
  });

  it('refuses an unknown property at the TOP level', async () => {
    await reject({ ...valid, sku: 'NOPE' });
  });

  it('refuses an unknown property INSIDE a member', async () => {
    await reject({ ...valid, members: [{ id: ID, label: 'S', price: 3 }] });
  });

  it('refuses a member id that is not a uuid', async () => {
    await reject({ ...valid, members: [{ id: 'a', label: 'S' }] });
  });

  it('refuses a whitespace-only name and a whitespace-only label', async () => {
    await reject({ ...valid, name: '   ' });
    await reject({ ...valid, members: [{ id: ID, label: '   ' }] });
  });

  it('refuses values longer than the columns they are stored in', async () => {
    await reject({ ...valid, name: 'a'.repeat(256) });
    await reject({ ...valid, metaTitle: 'a'.repeat(161) });
    await reject({ ...valid, metaDescription: 'a'.repeat(301) });
    await reject({ ...valid, members: [{ id: ID, label: 'a'.repeat(81) }] });
  });

  it('refuses a missing or empty members array', async () => {
    await reject({ name: 'Camiseta' });
    await reject({ ...valid, members: [] });
  });

  it('does NOT enforce the minimum member count — that rule has one owner', async () => {
    // `assertFamilyRequestShape` decides "at least two", and its sentence is
    // the one a reader sees. `@ArrayMinSize(2)` here would be a second
    // definition of the same rule, and the two would drift.
    await expect(accept({ ...valid, members: [{ id: ID, label: 'S' }] })).resolves.toBeDefined();
  });
});

/**
 * A CHILD MAY BE RENAMED AS PART OF THE GROUPING (PR D).
 *
 * The field is optional because leaving a name alone is the common case, and
 * an absent field must never be read as "blank". When present it is a real
 * product name, judged by the rules any product name is judged by, and it is
 * NOT the label: the two answer different questions about the same item.
 */
describe('CreateFamilyDto — renaming a child while grouping', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const meta = { type: 'body' as const, metatype: CreateFamilyDto, data: '' };
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const body = (members: any[]) => ({ name: 'Camiseta', members });

  it('accepts a member with no name: that item keeps the one it has', async () => {
    const out: any = await pipe.transform(
      body([
        { id: ID, label: 'S' },
        { id: ID2, label: 'M' },
      ]),
      meta,
    );
    expect(out.members[0].name).toBeUndefined();
    expect(out.members[0].label).toBe('S');
  });

  it('accepts a renamed member and keeps the label beside it', async () => {
    const out: any = await pipe.transform(
      body([
        { id: ID, label: 'S', name: 'Small' },
        { id: ID2, label: 'M' },
      ]),
      meta,
    );
    expect(out.members[0]).toEqual({ id: ID, label: 'S', name: 'Small' });
    expect(out.members[1].name).toBeUndefined();
  });

  it('trims before judging, so whitespace is not a name', async () => {
    const out: any = await pipe.transform(
      body([
        { id: ID, label: 'S', name: '  Small  ' },
        { id: ID2, label: 'M' },
      ]),
      meta,
    );
    expect(out.members[0].name).toBe('Small');
    await expect(
      pipe.transform(
        body([
          { id: ID, label: 'S', name: '   ' },
          { id: ID2, label: 'M' },
        ]),
        meta,
      ),
    ).rejects.toThrow();
  });

  it('refuses an empty name, rather than storing a nameless item', async () => {
    await expect(
      pipe.transform(
        body([
          { id: ID, label: 'S', name: '' },
          { id: ID2, label: 'M' },
        ]),
        meta,
      ),
    ).rejects.toThrow();
  });

  it('bounds the name by the column, accepting exactly 255 and refusing 256', async () => {
    const out: any = await pipe.transform(
      body([
        { id: ID, label: 'S', name: 'x'.repeat(255) },
        { id: ID2, label: 'M' },
      ]),
      meta,
    );
    expect(out.members[0].name).toHaveLength(255);
    await expect(
      pipe.transform(
        body([
          { id: ID, label: 'S', name: 'x'.repeat(256) },
          { id: ID2, label: 'M' },
        ]),
        meta,
      ),
    ).rejects.toThrow();
  });

  it('still refuses an unknown property inside a member', async () => {
    await expect(
      pipe.transform(
        body([
          { id: ID, label: 'S', slug: 'small' },
          { id: ID2, label: 'M' },
        ]),
        meta,
      ),
    ).rejects.toThrow();
  });
});
